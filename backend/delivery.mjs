import { createLeadService, failure } from './leads.mjs';
import { validateLead } from './validation.mjs';

export const validIdempotencyKey = key => typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
const success = row => ({ status: 200, body: { ok: true, requestId: row.request_id } });

// Explicit user retry can re-read an uncertain operation, but can never create it again.
export function createPersistentLeadService({ store, send, reconcile, now = Date.now,
  globalLimit = 30, windowMs = 60_000, onDelivery, ...limits } = {}) {
  const ingress = createLeadService({ ...limits, now });
  const running = new Map();
  let budget = { count: 0, until: 0 };
  async function submit(body, key) {
    const { lead, fieldErrors } = validateLead(body);
    if (!lead) return failure(400, 'VALIDATION_ERROR', { fieldErrors });
    if (!validIdempotencyKey(key)) return failure(400, 'INVALID_IDEMPOTENCY_KEY');
    key = key.toLowerCase();
    const time = now();
    const { row, conflict, full } = store.reserve(key, lead, time);
    if (full) return failure(503, 'DELIVERY_UNAVAILABLE');
    if (conflict) return failure(409, 'IDEMPOTENCY_CONFLICT');
    if (running.has(row.request_id)) return running.get(row.request_id);
    if (row.state === 'delivered') return success(row);
    if (row.retry_at > time) return failure(503, row.state === 'uncertain' ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_UNAVAILABLE');
    if (budget.until <= time) budget = { count: 0, until: time + windowMs };
    if (budget.count >= globalLimit) return failure(429, 'RATE_LIMITED');
    const operation = ['processing', 'uncertain'].includes(row.state) ? 'reconcile' : 'send';
    if (operation === 'reconcile' && typeof reconcile !== 'function') return failure(502, 'DELIVERY_UNCERTAIN');
    const claim = store.claim(row.request_id, operation, time);
    if (!claim) return failure(503, 'DELIVERY_PENDING');
    if (claim.blockedUntil > time) return failure(503, operation === 'reconcile' ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_UNAVAILABLE');
    if (Object.hasOwn(claim, 'current')) return claim.current?.state === 'delivered'
      ? success(claim.current) : failure(503, claim.current?.state === 'uncertain' ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_PENDING');
    budget.count++;
    const pending = Promise.resolve().then(async () => {
      let result;
      try {
        result = operation === 'reconcile' ? await reconcile(row.request_id) : await send(JSON.parse(row.payload_json), row.request_id);
      } catch { result = { kind: 'uncertain' }; }
      // Reconciliation errors/empty results must NEVER turn an unknown write into a retryable add.
      if (operation === 'reconcile' && result?.kind !== 'delivered') result = { kind: 'uncertain' };
      let finished;
      try { finished = store.finish(row.request_id, claim, result, now()); }
      catch {
        // The CRM call has happened. A failed local commit (or lost lease) is
        // not proof of remote failure; preserve the journal for reconciliation.
        finished = { state: 'uncertain' };
      }
      try { Promise.resolve(onDelivery?.({ requestId: row.request_id, outcome: finished.state, durationMs: Math.max(0, now() - time) })).catch(() => {}); } catch {}
      if (finished.state === 'delivered') return success(finished);
      return failure(finished.state === 'unconfigured' ? 503 : 502,
        finished.state === 'uncertain' ? 'DELIVERY_UNCERTAIN' : finished.state === 'rejected' ? 'DELIVERY_FAILED' : 'DELIVERY_UNAVAILABLE');
    }).finally(() => running.delete(row.request_id));
    running.set(row.request_id, pending);
    return pending;
  }
  return { admit: ingress.admit, submit };
}
