import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, directions } from '../validation.mjs';
import { createLeadService } from '../leads.mjs';

const valid = overrides => ({ schemaVersion: 1, name: 'Тестовая заявка', phone: '+70000000001', product: null,
  interests: ['undecided'], model: null, comment: '', consent: true, source: 'inline', ...overrides });

test('validates all directions, multi-interest and optional text without inventing a model', () => {
  for (const product of Object.keys(directions)) {
    assert.equal(validateLead(valid({ product, interests: [], source: 'brand-modal' })).lead.product, product);
  }
  const { lead } = validateLead(valid({ name: '  Тест  ', interests: ['water', 'drinkx'], comment: undefined }));
  assert.equal(lead.name, 'Тест');
  assert.deepEqual(lead.interests, ['drinkx', 'water']);
  assert.equal(lead.comment, '');
  assert.equal(lead.model, null);
});

test('rejects invalid shape, consent, phone, direction, source and lengths', () => {
  for (const body of [null, [], 'test', 1]) assert.ok(validateLead(body).fieldErrors);
  const cases = [
    ['schemaVersion', { schemaVersion: 2 }], ['name', { name: ' ' }], ['name', { name: 'я'.repeat(101) }],
    ['phone', { phone: '+7 (000) 000-00-01' }], ['phone', { phone: 70000000001 }],
    ['consent', { consent: false }], ['consent', { consent: 'true' }],
    ['product', { product: 'constructor' }], ['product', { product: undefined }],
    ['interests', { interests: [] }], ['interests', { interests: 'drinkx' }],
    ['interests', { interests: ['drinkx', 'drinkx'] }], ['interests', { interests: ['undecided', 'water'] }],
    ['interests', { interests: ['__proto__'] }], ['interests', { interests: [null] }],
    ['interests', { product: 'drinkx', source: 'brand-modal', interests: ['water'] }],
    ['model', { model: 5 }], ['model', { model: 'a'.repeat(121) }],
    ['comment', { comment: {} }], ['comment', { comment: 'a'.repeat(1001) }],
    ['source', { source: 'constructor' }], ['source', { source: 'brand-modal' }],
    ['source', { product: 'drinkx', interests: [], source: 'inline' }], ['form', { extra: true }],
  ];
  for (const [field, data] of cases) assert.ok(validateLead(valid(data)).fieldErrors?.[field], `${field}: ${JSON.stringify(data)}`);
  assert.ok(validateLead(valid({ name: 'я'.repeat(100), model: 'x'.repeat(120), comment: '😀'.repeat(1000) })).lead);
});

test('concurrent / sequential duplicates and shared general sources send once', async () => {
  let resolve;
  let calls = 0;
  const service = createLeadService({ send: async () => { calls++; return new Promise(r => { resolve = r; }); } });
  const first = service.submit(valid());
  const second = service.submit(valid({ source: 'hero-modal' }));
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ kind: 'delivered' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(a.body.requestId, b.body.requestId);
  assert.deepEqual(await service.submit(valid()), a);
  assert.equal(calls, 1);
});

test('uncertain delivery is remembered, and dedup does not mix brands or models', async () => {
  let calls = 0;
  let clock = 0;
  const service = createLeadService({ now: () => clock, dedupMs: 100, send: async () => { calls++; return { kind: 'uncertain' }; } });
  assert.equal((await service.submit(valid())).body.code, 'DELIVERY_UNCERTAIN');
  await service.submit(valid());
  assert.equal(calls, 1);
  await service.submit(valid({ product: 'drinkx', interests: [], source: 'brand-modal', model: 'S100' }));
  await service.submit(valid({ product: 'drinkx', interests: [], source: 'brand-modal', model: 'S400' }));
  assert.equal(calls, 3);
  clock = 101;
  await service.submit(valid());
  assert.equal(calls, 4);
});

test('ingress windows, bounded memory and upstream retry_after are enforced', async () => {
  let clock = 0;
  let calls = 0;
  const service = createLeadService({ now: () => clock, perIpLimit: 2, globalLimit: 3,
    send: async () => { calls++; return { kind: 'rejected', retryAfter: 60 }; } });
  assert.equal(service.admit('a'), true); assert.equal(service.admit('a'), true); assert.equal(service.admit('a'), false);
  assert.equal(service.admit('b'), true); assert.equal(service.admit('c'), true);
  assert.equal((await service.submit(valid())).status, 502);
  assert.equal((await service.submit(valid({ comment: 'different' }))).status, 503);
  assert.equal(calls, 1);
  clock = 60_001;
  assert.equal(service.admit('a'), true);
  await service.submit(valid()); assert.equal(calls, 2);
  const bounded = createLeadService({ maxEntries: 1, maxIpEntries: 1, send: async () => ({ kind: 'delivered' }) });
  assert.equal(bounded.admit('one'), true); assert.equal(bounded.admit('two'), false);
  assert.equal((await bounded.submit(valid())).status, 200);
  assert.equal((await bounded.submit(valid({ comment: 'new' }))).status, 503);
  assert.equal((await bounded.submit(valid())).status, 200);
});

test('only new validated deliveries consume the global budget, including concurrent reservations', async () => {
  let clock = 0;
  let calls = 0;
  let complete;
  const service = createLeadService({ now: () => clock, globalLimit: 1, send: () => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  } });
  for (let i = 0; i < 40; i++) {
    assert.equal(service.admit(`client-${i}`), true);
    assert.equal((await service.submit(valid({ consent: false }))).status, 400);
  }
  const first = service.submit(valid());
  const duplicate = service.submit(valid({ source: 'hero-modal' }));
  assert.equal((await service.submit(valid({ comment: 'another delivery' }))).status, 429);
  assert.equal(calls, 1);
  complete({ kind: 'delivered' });
  const delivered = await first;
  assert.deepEqual(await duplicate, delivered);
  assert.deepEqual(await service.submit(valid()), delivered);
  assert.equal(calls, 1);
  clock = 60_001;
  // A cache hit in the new window must still leave its one send slot available.
  assert.deepEqual(await service.submit(valid()), delivered);
  const next = service.submit(valid({ comment: 'another delivery' }));
  await Promise.resolve();
  assert.equal(calls, 2);
  complete({ kind: 'delivered' });
  assert.equal((await next).status, 200);
});

test('delivery events contain only safe fields and are emitted once for each actual attempt', async () => {
  let clock = 100;
  const events = [];
  const service = createLeadService({ now: () => clock, onDelivery: event => events.push(event), send: async () => {
    clock = 125;
    return { kind: 'delivered', description: 'private upstream data' };
  } });
  const response = await service.submit(valid({ comment: 'private customer text' }));
  await service.submit(valid({ comment: 'private customer text', source: 'hero-modal' }));
  assert.deepEqual(events, [{ requestId: response.body.requestId, outcome: 'delivered', durationMs: 25 }]);

  const unknownEvents = [];
  const unknown = createLeadService({ onDelivery: event => unknownEvents.push(event), send: async () => ({ kind: 'private unexpected error' }) });
  assert.equal((await unknown.submit(valid())).body.code, 'DELIVERY_UNCERTAIN');
  assert.equal(unknownEvents[0].outcome, 'uncertain');
  assert.deepEqual(Object.keys(unknownEvents[0]).sort(), ['durationMs', 'outcome', 'requestId']);
});

test('synchronous and asynchronous logging failures never change delivery success', async () => {
  for (const onDelivery of [() => { throw new Error('sink failed'); }, async () => { throw new Error('sink failed'); }]) {
    const service = createLeadService({ onDelivery, send: async () => ({ kind: 'delivered' }) });
    assert.equal((await service.submit(valid())).status, 200);
  }
});
