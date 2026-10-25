import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { validateLead } from './validation.mjs';

export const failure = (status, code, extra = {}) => ({ status, body: { ok: false, code, ...extra } });

export function createLeadService({ send, now = Date.now, dedupMs = 300_000, maxEntries = 1000,
  perIpLimit = 5, globalLimit = 30, windowMs = 60_000, maxIpEntries = 10_000 } = {}) {
  const secret = randomBytes(32);
  const digest = value => createHmac('sha256', secret).update(value).digest('hex');
  const deliveries = new Map();
  const limits = new Map();
  let global = { count: 0, until: 0 };
  let telegramBlockedUntil = 0;

  function admit(ip) {
    const time = now();
    for (const [key, value] of limits) if (value.until <= time) limits.delete(key);
    if (global.until <= time) global = { count: 0, until: time + windowMs };
    const key = digest(ip);
    const bucket = limits.get(key) || { count: 0, until: time + windowMs };
    if ((!limits.has(key) && limits.size >= maxIpEntries) || bucket.count >= perIpLimit || global.count >= globalLimit) return false;
    bucket.count++; global.count++; limits.set(key, bucket);
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
    if (telegramBlockedUntil > time) return failure(503, 'DELIVERY_UNAVAILABLE');
    if (deliveries.size >= maxEntries) return failure(503, 'DELIVERY_UNAVAILABLE');
    const requestId = randomUUID();
    const entry = { pending: true, until: Infinity };
    // Install the entry synchronously before starting IO, so concurrent requests share it.
    entry.promise = Promise.resolve().then(async () => {
      let result;
      try { result = await send(lead, requestId); } catch { result = { kind: 'uncertain' }; }
      entry.pending = false;
      entry.until = now() + dedupMs;
      if (result?.kind === 'delivered') return { status: 200, body: { ok: true, requestId } };
      if (result?.kind === 'unconfigured') {
        entry.until = now() + 1000;
        return failure(503, 'DELIVERY_UNAVAILABLE');
      }
      if (result?.kind === 'rejected') {
        const retryMs = Math.max(5, result.retryAfter || 5) * 1000;
        entry.until = now() + retryMs;
        telegramBlockedUntil = entry.until;
        return failure(502, 'DELIVERY_FAILED');
      }
      return failure(502, 'DELIVERY_UNCERTAIN');
    });
    deliveries.set(key, entry);
    return entry.promise;
  }
  return { admit, submit };
}
