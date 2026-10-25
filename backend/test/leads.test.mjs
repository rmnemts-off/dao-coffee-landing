import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, directions } from '../validation.mjs';
import { createTelegramSender, formatLead } from '../telegram.mjs';
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

test('Telegram HTML is escaped; no user markup becomes a link/tag', () => {
  const text = formatLead(valid({ name: '<b>Тест</b>', comment: '<a href="tg://user?id=1">&</a>', model: '<model>' }), 'test-id');
  assert.match(text, /&lt;b&gt;Тест&lt;\/b&gt;/);
  assert.match(text, /&lt;a href="tg:\/\/user\?id=1"&gt;&amp;&lt;\/a&gt;/);
  assert.equal(text.includes('<a '), false);
  assert.match(text, /Помогите определиться/);
  assert.match(text, /Нижняя форма/);
});

test('Telegram confirms success only on a valid sendMessage result', async () => {
  let calls = 0;
  const send = createTelegramSender({ token: '1:mock-token', chatId: '-123', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.telegram.org/bot1:mock-token/sendMessage');
    assert.equal(options.redirect, 'error');
    const message = JSON.parse(options.body);
    assert.equal(message.chat_id, '-123');
    assert.equal(message.parse_mode, 'HTML');
    assert.equal(message.link_preview_options.is_disabled, true);
    return Response.json({ ok: true, result: { message_id: 42 } });
  } });
  assert.equal((await send(valid(), 'test')).kind, 'delivered');
  assert.equal(calls, 1);
});

test('no credentials means no outbound network; tokens and upstream errors are never returned', async () => {
  const send = createTelegramSender({ fetchImpl: () => { assert.fail('must not call Telegram'); } });
  assert.deepEqual(await send(valid(), 'test'), { kind: 'unconfigured' });
  for (const [response, kind] of [
    [Response.json({ ok: false, error_code: 403, description: 'private upstream error' }, { status: 403 }), 'rejected'],
    [Response.json({ ok: true }), 'uncertain'],
    [Response.json({ ok: true, result: { message_id: 0 } }), 'uncertain'],
    [Response.json({ ok: false, error_code: 500 }, { status: 500 }), 'uncertain'],
    [new Response('not-json', { status: 502 }), 'uncertain'],
  ]) {
    const result = await createTelegramSender({ token: '1:mock-token', chatId: '-123', fetchImpl: async () => response })(valid(), 'test');
    assert.equal(result.kind, kind);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('timeout covers both HTTP and response body, aborts, and never retries', async () => {
  for (const stalledBody of [false, true]) {
    let calls = 0;
    let signal;
    const send = createTelegramSender({ token: '1:mock-token', chatId: '-123', timeoutMs: 15, fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      if (stalledBody) return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    assert.deepEqual(await send(valid(), 'test'), { kind: 'uncertain' });
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
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

test('rate windows, bounded memory and upstream retry_after are enforced', async () => {
  let clock = 0;
  let calls = 0;
  const service = createLeadService({ now: () => clock, perIpLimit: 2, globalLimit: 3,
    send: async () => { calls++; return { kind: 'rejected', retryAfter: 60 }; } });
  assert.equal(service.admit('a'), true); assert.equal(service.admit('a'), true); assert.equal(service.admit('a'), false);
  assert.equal(service.admit('b'), true); assert.equal(service.admit('c'), false);
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
