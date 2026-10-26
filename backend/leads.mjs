import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { validateLead } from './validation.mjs';

export const failure = (status, code, extra = {}) => ({ status, body: { ok: false, code, ...extra } });

export function createLeadService({ send, now = Date.now, dedupMs = 300_000, maxEntries = 1000,
  perIpLimit = 5, globalLimit = 30, windowMs = 60_000, maxIpEntries = 10_000, onDelivery } = {}) {
  const secret = randomBytes(32);
  const digest = value => createHmac('sha256', secret).update(value).digest('hex');
  const deliveries = new Map();
  const limits = new Map();
  let global = { count: 0, until: 0 };
  let upstreamBlockedUntil = 0;

  function admit(ip) {
    const time = now();
    for (const [key, value] of limits) if (value.until <= time) limits.delete(key);
    const key = digest(ip);
    const bucket = limits.get(key) || { count: 0, until: time + windowMs };
    if ((!limits.has(key) && limits.size >= maxIpEntries) || bucket.count >= perIpLimit) return false;
    bucket.count++; limits.set(key, bucket);
    return true;
  }

  async function submit(body) {
    const { lead, fieldErrors } = validateLead(body);
    if (!lead) return failure(400, 'VALIDATION_ERROR', { fieldErrors });
    const time = now();
    for (const [key, value] of deliveries) if (value.until <= time && !value.pending) deliveries.delete(key);
    // General inline and modal submissions share a draft. Source is metadata, not identity.
    const { source: _source, ...identity } = lead;
    const key = digest(JSON.stringify(identity));
    if (deliveries.has(key)) return deliveries.get(key).promise;
    if (upstreamBlockedUntil > time) return failure(503, 'DELIVERY_UNAVAILABLE');
    if (deliveries.size >= maxEntries) return failure(503, 'DELIVERY_UNAVAILABLE');
    // Only a validated, new delivery consumes the process-wide send budget.
    if (global.until <= time) global = { count: 0, until: time + windowMs };
    if (global.count >= globalLimit) return failure(429, 'RATE_LIMITED');
    global.count++;
    const requestId = randomUUID();
    const entry = { pending: true, until: Infinity };
    // Install the entry synchronously before starting IO, so concurrent requests share it.
    entry.promise = Promise.resolve().then(async () => {
      const startedAt = now();
      let result;
      try { result = await send(lead, requestId); } catch { result = { kind: 'uncertain' }; }
      const outcome = ['delivered', 'unconfigured', 'rejected'].includes(result?.kind) ? result.kind : 'uncertain';
      // The sink receives a fixed allowlist, never a lead, IP, credential or upstream error.
      // Logging failures must not change a delivery's result.
      try { Promise.resolve(onDelivery?.({ requestId, outcome, durationMs: Math.max(0, now() - startedAt) })).catch(() => {}); } catch {}
      entry.pending = false;
      entry.until = now() + dedupMs;
      if (outcome === 'delivered') return { status: 200, body: { ok: true, requestId } };
      if (outcome === 'unconfigured') {
        entry.until = now() + 1000;
        return failure(503, 'DELIVERY_UNAVAILABLE');
      }
      if (outcome === 'rejected') {
        const retryMs = Math.max(5, result.retryAfter || 5) * 1000;
        entry.until = now() + retryMs;
        upstreamBlockedUntil = Math.max(upstreamBlockedUntil, entry.until);
        return failure(502, 'DELIVERY_FAILED');
      }
      return failure(502, 'DELIVERY_UNCERTAIN');
    });
    deliveries.set(key, entry);
    return entry.promise;
  }
  return { admit, submit };
}
