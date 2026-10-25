import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLeadStore } from '../store.mjs';
import { createPersistentLeadService } from '../delivery.mjs';
import { createServer } from '../server.mjs';

const valid = extra => ({ schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: 'drinkx',
  interests: [], model: null, comment: '', consent: true, source: 'brand-modal', ...extra });
const delivered = { kind: 'delivered', entityTypeId: 2, crmId: 321, contactId: 123 };
function journal(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dao-journal-'));
  const filename = join(dir, 'leads.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return filename;
}

test('persists product snapshot, consent and CRM IDs; retry after restart cannot add again', async t => {
  const filename = journal(t), key = randomUUID();
  let store = openLeadStore(filename), calls = 0;
  let service = createPersistentLeadService({ store, send: async () => { calls++; return delivered; } });
  const first = await service.submit(valid({ model: 'S100' }), key);
  assert.equal(first.status, 200);
  const row = store.get(first.body.requestId);
  assert.equal(JSON.parse(row.payload_json).model, 'S100');
  assert.equal(JSON.parse(row.payload_json).consent, true);
  assert.equal(row.crm_id, 321); assert.equal(row.contact_id, 123);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  store.close();
  store = openLeadStore(filename); t.after(() => store.close());
  service = createPersistentLeadService({ store, send: async () => { calls++; return delivered; } });
  assert.deepEqual(await service.submit(valid({ model: 'S100' }), key), first);
  assert.equal(calls, 1);
});

test('concurrent identical keys share a single delivery and conflicting payload is rejected', async t => {
  const store = openLeadStore(); t.after(() => store.close());
  const key = randomUUID(); let calls = 0, complete;
  const service = createPersistentLeadService({ store, send: () => { calls++; return new Promise(r => { complete = r; }); } });
  const first = service.submit(valid(), key), second = service.submit(valid(), key);
  assert.equal((await service.submit(valid({ comment: 'Changed' }), key)).status, 409);
  assert.equal(calls, 1); complete(delivered);
  assert.deepEqual(await first, await second);
  const next = service.submit(valid(), randomUUID()); await Promise.resolve(); complete(delivered);
  assert.equal((await next).status, 200); assert.equal(calls, 2); // a genuinely new inquiry
});

test('uncertain result stays read-only after restart and after arbitrarily long delay', async t => {
  const filename = journal(t), key = randomUUID(); let time = 0, sends = 0, reads = 0;
  let store = openLeadStore(filename);
  let service = createPersistentLeadService({ store, now: () => time, send: async () => { sends++; return { kind: 'uncertain' }; } });
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_UNCERTAIN');
  store.close(); store = openLeadStore(filename); t.after(() => store.close());
  time = 1_000_000_000;
  service = createPersistentLeadService({ store, now: () => time,
    send: async () => { sends++; return delivered; }, reconcile: async () => { reads++; return { kind: 'unconfigured' }; } });
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_UNCERTAIN');
  time += 10_000;
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_UNCERTAIN');
  assert.equal(sends, 1); assert.equal(reads, 2);
});

test('lost successful CRM response is recovered by marker without a second add', async t => {
  const store = openLeadStore(); t.after(() => store.close());
  const key = randomUUID(); let time = 0, sends = 0;
  const service = createPersistentLeadService({ store, now: () => time,
    send: async () => { sends++; return { kind: 'uncertain' }; }, reconcile: async () => delivered });
  await service.submit(valid(), key); time = 6000;
  const result = await service.submit(valid(), key);
  assert.equal(result.status, 200); assert.equal(sends, 1);
  assert.equal(store.get(result.body.requestId).crm_id, 321);
});

test('persisted in-flight operation after process death can only reconcile', async t => {
  const filename = journal(t), key = randomUUID(); let store = openLeadStore(filename);
  const { row } = store.reserve(key, valid(), 0);
  store.claim(row.request_id, 'send', 0); store.close();
  store = openLeadStore(filename); t.after(() => store.close());
  let time = 1000, sends = 0;
  const service = createPersistentLeadService({ store, now: () => time,
    send: async () => { sends++; return delivered; }, reconcile: async () => delivered });
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_PENDING');
  time = 61_000;
  assert.equal((await service.submit(valid(), key)).status, 200); assert.equal(sends, 0);
});

test('shared SQLite lock serializes writes across service instances, preserving the waiting inquiry', async t => {
  const filename = journal(t); const a = openLeadStore(filename), b = openLeadStore(filename);
  t.after(() => { a.close(); b.close(); });
  let complete, calls = 0;
  const first = createPersistentLeadService({ store: a, send: () => new Promise(r => { complete = r; }) });
  const second = createPersistentLeadService({ store: b, send: async () => { calls++; return delivered; } });
  const p = first.submit(valid(), randomUUID()); await Promise.resolve();
  const key = randomUUID();
  assert.equal((await second.submit(valid({ product: 'water' }), key)).body.code, 'DELIVERY_PENDING');
  assert.equal(calls, 0); complete(delivered); await p;
  assert.equal((await second.submit(valid({ product: 'water' }), key)).status, 200); assert.equal(calls, 1);
});

test('known rejection permits explicit retry with the original request ID only after backoff', async t => {
  const store = openLeadStore(); t.after(() => store.close());
  let time = 0; const ids = [], key = randomUUID();
  const service = createPersistentLeadService({ store, now: () => time, send: async (_lead, id) => {
    ids.push(id); return ids.length === 1 ? { kind: 'rejected', retryAfter: 60 } : delivered;
  } });
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_FAILED');
  assert.equal((await service.submit(valid(), key)).status, 503);
  time = 60_001; assert.equal((await service.submit(valid(), key)).status, 200);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test('upstream cooldown blocks a new key after reopening the shared journal', async t => {
  const filename = journal(t); let time = 0, sends = 0;
  let store = openLeadStore(filename);
  const first = createPersistentLeadService({ store, now: () => time, send: async () => {
    sends++; return { kind: 'rejected', retryAfter: 60 };
  } });
  assert.equal((await first.submit(valid(), randomUUID())).body.code, 'DELIVERY_FAILED');
  store.close();
  store = openLeadStore(filename); t.after(() => store.close());
  const next = createPersistentLeadService({ store, now: () => time, send: async () => { sends++; return delivered; } });
  const key = randomUUID(), body = valid({ comment: 'A different inquiry' });
  time = 1000;
  assert.equal((await next.submit(body, key)).body.code, 'DELIVERY_UNAVAILABLE');
  assert.equal(sends, 1);
  assert.equal(store.list().filter(row => row.state === 'received').length, 1);
  time = 60_000;
  assert.equal((await next.submit(body, key)).status, 200);
  assert.equal(sends, 2);
});

test('a late short refusal cannot shorten a concurrent worker longer cooldown after lease takeover', async t => {
  const filename = journal(t), a = openLeadStore(filename), b = openLeadStore(filename);
  t.after(() => { a.close(); b.close(); });
  let time = 0, finishSlow, finishNew, extraSends = 0;
  const slow = createPersistentLeadService({ store: a, now: () => time,
    send: () => new Promise(resolve => { finishSlow = resolve; }) });
  const newer = createPersistentLeadService({ store: b, now: () => time,
    send: () => new Promise(resolve => { finishNew = resolve; }) });
  const first = slow.submit(valid({ comment: 'Slow worker' }), randomUUID());
  await Promise.resolve();
  // Simulate a suspended worker: its lease expires before its remote response.
  time = 61_000;
  const second = newer.submit(valid({ comment: 'New lease owner' }), randomUUID());
  await Promise.resolve();
  finishNew({ kind: 'rejected', retryAfter: 60 });
  assert.equal((await second).body.code, 'DELIVERY_FAILED');
  time = 62_000;
  finishSlow({ kind: 'rejected', retryAfter: 5 });
  assert.equal((await first).body.code, 'DELIVERY_UNCERTAIN');
  const next = createPersistentLeadService({ store: a, now: () => time,
    send: async () => { extraSends++; return delivered; } });
  const key = randomUUID(), body = valid({ comment: 'Third inquiry' });
  time = 68_000;
  assert.equal((await next.submit(body, key)).body.code, 'DELIVERY_UNAVAILABLE');
  assert.equal(extraSends, 0);
  time = 121_000;
  assert.equal((await next.submit(body, key)).status, 200);
  assert.equal(extraSends, 1);
});

test('a journal commit failure after CRM success stays uncertain and recovers without another send', async t => {
  const store = openLeadStore(); t.after(() => store.close());
  let time = 0, writes = 0, reads = 0, failCommit = true;
  const events = [];
  const service = createPersistentLeadService({ now: () => time, onDelivery: event => events.push(event),
    store: { ...store, finish: (...args) => {
      if (failCommit) { failCommit = false; throw new Error('Simulated private database I/O failure'); }
      return store.finish(...args);
    } },
    send: async () => { writes++; return delivered; }, reconcile: async () => { reads++; return delivered; } });
  const key = randomUUID();
  const response = await service.submit(valid(), key);
  assert.equal(response.status, 502); assert.equal(response.body.code, 'DELIVERY_UNCERTAIN');
  const row = store.list()[0];
  assert.equal(row.state, 'processing');
  assert.deepEqual(events, [{ requestId: row.request_id, outcome: 'uncertain', durationMs: 0 }]);
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.equal((await service.submit(valid(), key)).body.code, 'DELIVERY_PENDING');
  time = 61_000;
  const recovered = await service.submit(valid(), key);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.requestId, row.request_id);
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(store.get(row.request_id).crm_id, delivered.crmId);
});

test('invalid body/key never creates an attempt; public directory cannot host a journal', async t => {
  const store = openLeadStore(); t.after(() => store.close());
  let calls = 0;
  const service = createPersistentLeadService({ store, send: async () => { calls++; return delivered; } });
  assert.equal((await service.submit(valid({ consent: false }), randomUUID())).status, 400);
  assert.equal((await service.submit(valid(), 'invalid')).body.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal(calls, 0);
  assert.throws(() => openLeadStore('site/leads.sqlite'), /outside site/);
  assert.throws(() => openLeadStore('site/..leads.sqlite'), /outside site/);
});

test('HTTP persistent path accepts UUID header and replays confirmed response after reopening', async t => {
  const filename = journal(t), key = randomUUID(); let calls = 0;
  async function start() {
    const server = createServer({ env: { LEADS_DB_PATH: filename }, send: async () => { calls++; return delivered; } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}/api/leads` };
  }
  let { server, url } = await start();
  const request = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(valid()) });
  const first = await (await request()).json(); assert.equal(first.ok, true);
  await server.shutdown();
  ({ server, url } = await start()); t.after(() => server.shutdown());
  assert.deepEqual(await (await request()).json(), first); assert.equal(calls, 1);
});


test('stale reserved snapshots cannot claim a new send after another worker finishes', t => {
  const filename = journal(t), key = randomUUID();
  const a = openLeadStore(filename), b = openLeadStore(filename);
  t.after(() => { a.close(); b.close(); });
  const first = a.reserve(key, valid(), 0).row;
  b.reserve(key, valid(), 0); // worker B reads before A changes the row
  const claim = a.claim(first.request_id, 'send', 1);
  a.finish(first.request_id, claim, delivered, 2);
  const staleClaim = b.claim(first.request_id, 'send', 3);
  assert.equal(staleClaim.current.state, 'delivered');
  assert.equal(staleClaim.owner, undefined);
});


test('outstanding capacity stops new reservations but preserves retry/recovery of existing keys', async t => {
  const store = openLeadStore(':memory:', { maxOutstanding: 1 }); t.after(() => store.close());
  const key = randomUUID(); let clock = 0, sends = 0;
  const service = createPersistentLeadService({ store, now: () => clock,
    send: async () => { sends++; return { kind: 'uncertain' }; }, reconcile: async () => delivered });
  await service.submit(valid(), key);
  assert.equal((await service.submit(valid({ comment: 'new' }), randomUUID())).status, 503);
  clock = 6000;
  assert.equal((await service.submit(valid(), key)).status, 200);
  assert.equal(store.list().length, 1); assert.equal(sends, 1);
});


test('incomplete delivery metadata and corrupted confirmed IDs cannot produce success', async t => {
  const filename = journal(t); const store = openLeadStore(filename); t.after(() => store.close());
  let time = 0;
  const invalid = createPersistentLeadService({ store, send: async () => ({ kind: 'delivered' }) });
  assert.equal((await invalid.submit(valid(), randomUUID())).body.code, 'DELIVERY_UNCERTAIN');
  const key = randomUUID(); let writes = 0, reads = 0;
  const service = createPersistentLeadService({ store, now: () => time,
    send: async () => { writes++; return delivered; }, reconcile: async () => { reads++; return delivered; } });
  const first = await service.submit(valid(), key);
  const raw = new DatabaseSync(filename);
  raw.prepare('UPDATE submissions SET crm_id=NULL WHERE request_id=?').run(first.body.requestId); raw.close();
  time = 6000;
  assert.equal(store.get(first.body.requestId).state, 'uncertain');
  assert.equal((await service.submit(valid(), key)).status, 200);
  assert.equal(writes, 1); assert.equal(reads, 1);
});

test('operator journal keeps old unresolved requests visible before successful traffic', t => {
  const store = openLeadStore(); t.after(() => store.close());
  const old = store.reserve(randomUUID(), valid(), 0).row;
  const claim = store.claim(old.request_id, 'send', 0);
  store.finish(old.request_id, claim, { kind: 'uncertain' }, 1);
  for (let i = 0; i < 110; i++) {
    const row = store.reserve(randomUUID(), valid(), i + 2).row;
    store.finish(row.request_id, store.claim(row.request_id, 'send', i + 2), delivered, i + 2);
  }
  assert.equal(store.list()[0].request_id, old.request_id);
  assert.equal(store.list()[0].state, 'uncertain');
});
