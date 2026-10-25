import test from 'node:test';
import assert from 'node:assert/strict';
import { bitrixConfig, createBitrixReconciler, createBitrixSender, formatComments, inspectBitrix, parseWebhook } from '../bitrix.mjs';

const env = { BITRIX_WEBHOOK_URL: 'https://crm.example/rest/1/mock-secret/', BITRIX_ENTITY_TYPE_ID: '1',
  BITRIX_ASSIGNED_BY_ID: '7', BITRIX_STAGE_ID: 'NEW', BITRIX_SOURCE_ID: 'WEB' };
const dealEnv = { ...env, BITRIX_ENTITY_TYPE_ID: '2', BITRIX_CATEGORY_ID: '4', BITRIX_STAGE_ID: 'C4:NEW' };
const lead = { name: 'Тест', phone: '+70000000001', product: 'drinkx', interests: [], model: 'S100',
  comment: '', consent: true, source: 'brand-modal' };
const created = id => Response.json({ result: { item: { id } } });

test('Bitrix configuration requires an explicit destination and never falls back to Telegram', async () => {
  for (const config of [{}, { TELEGRAM_BOT_TOKEN: '1:legacy', TELEGRAM_CHAT_ID: '123' },
    { ...env, BITRIX_ENTITY_TYPE_ID: '' }, { ...env, BITRIX_ENTITY_TYPE_ID: '128' },
    { ...env, BITRIX_ASSIGNED_BY_ID: '0' }, { ...env, BITRIX_STAGE_ID: '' },
    { ...dealEnv, BITRIX_CATEGORY_ID: '' }, { ...env, BITRIX_WEBHOOK_URL: 'http://crm.example/rest/1/secret/' },
    { ...env, BITRIX_SOURCE_ID: undefined }, { ...env, BITRIX_SOURCE_ID: '' },
    { ...env, BITRIX_SOURCE_ID: 1 }, { ...env, BITRIX_SOURCE_ID: '<invalid>' }]) {
    assert.equal(bitrixConfig(config), null);
    assert.deepEqual(await createBitrixSender({ env: config, fetchImpl: () => assert.fail('must not send') })(lead, 'id'), { kind: 'unconfigured' });
    assert.deepEqual(await createBitrixReconciler({ env: config, fetchImpl: () => assert.fail('must not query') })('id'), { kind: 'unconfigured' });
  }
  for (const value of ['https://user:password@crm.example/rest/1/secret/', 'https://crm.example/rest/1/secret/?key=x',
    'https://crm.example/rest/1/secret/#x', 'https://crm.example/rest/1/secret/crm.item.add.json',
    'https://crm.example:8443/rest/1/secret/', 'not-a-url']) assert.equal(parseWebhook(value), null);
  assert.ok(bitrixConfig({ ...dealEnv, BITRIX_CATEGORY_ID: '0' }));
});

test('lead maps to crm.item.add with a real phone multifield and confirmed routing', async () => {
  let calls = 0;
  const send = createBitrixSender({ env: { ...env, BITRIX_SOURCE_ID: 'WEB' }, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${env.BITRIX_WEBHOOK_URL}crm.item.add.json`);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const { entityTypeId, fields } = JSON.parse(options.body);
    assert.equal(entityTypeId, 1);
    assert.equal(fields.assignedById, 7); assert.equal(fields.stageId, 'NEW'); assert.equal(fields.sourceId, 'WEB');
    assert.equal(fields.opened, 'N');
    assert.equal(fields.name, lead.name); assert.deepEqual(fields.fm, [{ typeId: 'PHONE', valueType: 'WORK', value: lead.phone }]);
    assert.equal(fields.originId, 'request-id'); assert.equal(fields.originatorId, 'DAO_COFFEE_WEBSITE');
    assert.match(fields.comments, /DrinkX/); assert.match(fields.comments, /S100/);
    assert.equal(fields.statusId, undefined); assert.equal(fields.categoryId, undefined);
    return created(42);
  } });
  assert.deepEqual(await send(lead, 'request-id'), { kind: 'delivered', entityTypeId: 1, crmId: 42 });
  assert.equal(calls, 1);
});

test('visitor comments cannot introduce HTML or BBCode; general context is preserved', () => {
  const text = formatComments({ ...lead, product: null, interests: ['water', 'coffee'], model: null,
    name: '<b>Имя</b>', comment: '[url=https://evil.example]<img src=x>&"[/url]', source: 'inline' }, 'id');
  assert.equal(text.includes('<b>'), false); assert.equal(text.includes('[url='), false);
  assert.match(text, /&lt;img/); assert.match(text, /&#91;url/); assert.match(text, /&amp;/);
  assert.match(text, /Водоподготовка, Кофе и СТМ/); assert.match(text, /Нижняя форма/);
  assert.match(text, /Модель: Не выбрана/);
});

test('deal reuses one matching contact without modifying it', async () => {
  const calls = [];
  const send = createBitrixSender({ env: dealEnv, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (calls.length === 1) {
      assert.match(url, /crm\.duplicate\.findbycomm\.json$/);
      assert.deepEqual(body, { entity_type: 'CONTACT', type: 'PHONE', values: [lead.phone] });
      return Response.json({ result: { CONTACT: [23] } });
    }
    assert.equal(body.entityTypeId, 2);
    assert.deepEqual(body.fields.contactIds, [23]); assert.equal(body.fields.categoryId, 4);
    assert.equal(body.fields.stageId, 'C4:NEW'); assert.equal(body.fields.fm, undefined);
    assert.equal(body.fields.opened, 'N');
    assert.match(body.fields.comments, /\+70000000001/);
    return created('99');
  } });
  assert.deepEqual(await send(lead, 'id'), { kind: 'delivered', entityTypeId: 2, crmId: 99, contactId: 23 }); assert.equal(calls.length, 2);
});

test('new contact precedes the deal; a contact alone is never reported as a delivered lead', async () => {
  for (const succeed of [true, false]) {
    let calls = 0;
    const send = createBitrixSender({ env: dealEnv, fetchImpl: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if (calls === 1) return Response.json({ result: [] });
      if (calls === 2) {
        assert.equal(body.entityTypeId, 3); assert.equal(body.fields.fm[0].value, lead.phone);
        assert.equal(body.fields.sourceId, dealEnv.BITRIX_SOURCE_ID);
        assert.equal(body.fields.opened, 'N');
        assert.equal(body.fields.originatorId, 'DAO_COFFEE_WEBSITE'); assert.equal(body.fields.originId, 'id:contact');
        return created(23);
      }
      assert.equal(body.entityTypeId, 2); assert.deepEqual(body.fields.contactIds, [23]);
      return succeed ? created(42) : Response.json({ error: 'ACCESS_DENIED', error_description: 'secret CRM data' });
    } });
    const result = await send(lead, 'id');
    assert.equal(result.kind, succeed ? 'delivered' : 'rejected'); assert.equal(calls, 3);
    if (succeed) assert.deepEqual(result, { kind: 'delivered', entityTypeId: 2, crmId: 42, contactId: 23 });
  }
});

test('ambiguous or malformed contact lookup never creates or attaches an arbitrary contact', async () => {
  for (const [result, kind] of [[{ CONTACT: [1, 2] }, 'rejected'], [{ CONTACT: ['bad'] }, 'uncertain'], [true, 'uncertain']]) {
    let calls = 0;
    const send = createBitrixSender({ env: dealEnv, fetchImpl: async () => { calls++; return Response.json({ result }); } });
    assert.equal((await send(lead, 'id')).kind, kind); assert.equal(calls, 1);
  }
});

test('only a valid created item confirms success; application errors on HTTP 200 are failures', async () => {
  for (const [response, kind] of [
    [Response.json({ result: true }), 'uncertain'], [created(0), 'uncertain'], [created(false), 'uncertain'], [created([42]), 'uncertain'],
    [Response.json({ error: 'ACCESS_DENIED', error_description: 'sensitive' }), 'rejected'],
    [Response.json({ error: 'QUERY_LIMIT_EXCEEDED' }, { status: 503 }), 'rejected'],
    [Response.json({ error: 'INTERNAL_SERVER_ERROR' }, { status: 500 }), 'uncertain'],
    [Response.json({ error: 'unknown', error_description: 'sensitive' }), 'uncertain'],
    [new Response('private error page', { status: 502 }), 'uncertain'],
  ]) {
    let calls = 0;
    const result = await createBitrixSender({ env, fetchImpl: async () => { calls++; return response; } })(lead, 'id');
    assert.equal(result.kind, kind); assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
    assert.equal(JSON.stringify(result).includes('mock-secret'), false);
  }
});

test('network errors, response-body stalls and timeouts abort without retry or leaking secrets', async () => {
  for (const mode of ['throws', 'headers', 'body']) {
    let calls = 0, signal;
    const send = createBitrixSender({ env, timeoutMs: 15, fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      if (mode === 'throws') throw new Error(`private ${env.BITRIX_WEBHOOK_URL}`);
      if (mode === 'body') return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    assert.deepEqual(await send(lead, 'id'), { kind: 'uncertain' }); assert.equal(calls, 1);
    if (mode !== 'throws') assert.equal(signal.aborted, true);
  }
});

test('late lookup/contact replies after the overall deadline cannot trigger another CRM write', async () => {
  for (const stallAt of [1, 2]) {
    let calls = 0, complete;
    const send = createBitrixSender({ env: dealEnv, timeoutMs: 15, fetchImpl: async () => {
      calls++;
      if (calls === stallAt) return new Promise(resolve => { complete = resolve; });
      if (calls === 1) return Response.json({ result: {} });
      assert.fail('must not create a deal after timeout');
    } });
    assert.deepEqual(await send(lead, 'id'), { kind: 'uncertain' });
    complete(stallAt === 1 ? Response.json({ result: {} }) : created(23));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, stallAt);
  }
});

test('a lost successful create is recovered by a read-only marker lookup, never another add', async () => {
  const calls = [];
  let savedDeal;
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1), body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'crm.duplicate.findbycomm.json') return Response.json({ result: { CONTACT: [23] } });
    if (method === 'crm.item.add.json') {
      assert.equal(savedDeal, undefined, 'a second create must never happen');
      savedDeal = { id: 42, contactIds: body.fields.contactIds };
      // The portal committed the card, but the success response was lost.
      throw new Error(`lost response from ${env.BITRIX_WEBHOOK_URL}`);
    }
    assert.equal(method, 'crm.item.list.json');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(body, { entityTypeId: 2,
      filter: { '=originatorId': 'DAO_COFFEE_WEBSITE', '=originId': 'persisted-request' },
      select: ['id', 'contactIds'], start: 0 });
    return Response.json({ result: { items: [savedDeal] }, total: 1 });
  };
  assert.deepEqual(await createBitrixSender({ env: dealEnv, fetchImpl })(lead, 'persisted-request'), { kind: 'uncertain' });
  const reconcile = createBitrixReconciler({ env: dealEnv, fetchImpl });
  assert.deepEqual(await reconcile('persisted-request'), { kind: 'delivered', entityTypeId: 2, crmId: 42, contactId: 23 });
  assert.deepEqual(calls.map(({ method }) => method), ['crm.duplicate.findbycomm.json', 'crm.item.add.json', 'crm.item.list.json']);
});

test('reconciliation requires exactly one valid item across all pages and otherwise remains uncertain', async () => {
  const cases = [
    { result: { items: [] }, total: 0 },
    { result: { items: [{ id: 41 }, { id: 42 }] }, total: 2 },
    { result: { items: [{ id: 41 }] }, total: 51, next: 50 },
    { result: { items: [{ id: 41 }] }, total: 1, next: 50 },
    { result: { items: [{ id: 41 }] } },
    { result: { items: [{ id: 0 }] }, total: 1 },
    { result: { items: [{ id: false }] }, total: 1 },
    { result: { items: [{ id: 41, contactIds: '23' }] }, total: 1 },
    { result: { items: [{ id: 41, contactIds: ['bad'] }] }, total: 1 },
    { result: { items: 'not-an-array' }, total: 1 },
    { result: true, total: 1 },
  ];
  for (const data of cases) {
    let calls = 0;
    const reconcile = createBitrixReconciler({ env: dealEnv, fetchImpl: async url => {
      calls++; assert.match(url, /crm\.item\.list\.json$/); return Response.json(data);
    } });
    assert.deepEqual(await reconcile('id'), { kind: 'uncertain' });
    assert.equal(calls, 1);
  }
});

test('reconciliation returns only confirmed internal IDs, not CRM record contents', async () => {
  const reconcile = createBitrixReconciler({ env, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).entityTypeId, 1);
    return Response.json({ result: { items: [{ id: '42', title: 'private customer',
      phone: '+70000000001', rawSecret: env.BITRIX_WEBHOOK_URL }] }, total: 1 });
  } });
  assert.deepEqual(await reconcile('id'), { kind: 'delivered', entityTypeId: 1, crmId: 42 });
  for (const requestId of ['', null, [], {}, 'id/with/slash', 'x'.repeat(101)]) {
    assert.deepEqual(await createBitrixReconciler({ env, fetchImpl: () => assert.fail('invalid marker must not query') })(requestId),
      { kind: 'uncertain' });
  }
});

test('reconciliation read failures, body stalls, and timeouts cannot clear an uncertain write', async () => {
  for (const mode of ['denied', 'limited', 'server', 'malformed', 'throws', 'headers', 'body']) {
    let calls = 0, signal;
    const reconcile = createBitrixReconciler({ env, timeoutMs: 15, fetchImpl: async (url, options) => {
      calls++; signal = options.signal; assert.match(url, /crm\.item\.list\.json$/);
      if (mode === 'denied') return Response.json({ error: 'ACCESS_DENIED', error_description: 'private customer and mock-secret' });
      if (mode === 'limited') return Response.json({ error: 'QUERY_LIMIT_EXCEEDED' }, { status: 429 });
      if (mode === 'server') return Response.json({ error: 'INTERNAL_SERVER_ERROR' }, { status: 500 });
      if (mode === 'malformed') return new Response('private error page');
      if (mode === 'throws') throw new Error(`private ${env.BITRIX_WEBHOOK_URL}`);
      if (mode === 'body') return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    assert.deepEqual(await reconcile('id'), { kind: 'uncertain' });
    assert.equal(calls, 1);
    if (mode === 'headers' || mode === 'body') assert.equal(signal.aborted, true);
  }
});

test('inspection uses only read methods and returns configuration metadata, not customers or credentials', async () => {
  const seen = [];
  const report = await inspectBitrix({ webhookUrl: env.BITRIX_WEBHOOK_URL, fetchImpl: async (url, options) => {
    const method = url.split('/').at(-1), params = JSON.parse(options.body); seen.push({ method, params });
    assert.equal(options.redirect, 'error');
    if (method === 'crm.settings.mode.get.json') return Response.json({ result: 2 });
    if (method === 'crm.item.fields.json') return Response.json({ result: { fields: { [params.entityTypeId === 3 ? 'fm' : 'title']: {
      type: params.entityTypeId === 3 ? 'crm_multifield' : 'string', isRequired: false, isReadOnly: false,
      ignored: 'private mock data',
    } } } });
    if (method === 'crm.status.list.json') return Response.json({ result: params.filter.ENTITY_ID === 'SOURCE'
      ? [{ STATUS_ID: 'STORE', NAME: 'Веб-сайт', ignored: 'private mock data' }] : [{ STATUS_ID: 'NEW', NAME: 'Новая' }] });
    if (method === 'crm.category.list.json') return Response.json({ result: { categories: [{ id: 0, name: 'Продажи', isDefault: 'Y' }] } });
    assert.fail('unexpected method');
  } });
  assert.equal(seen.length, 6); assert.equal(report.suggestedEntityTypeId, 2);
  assert.equal(seen.filter(({ method }) => method === 'crm.item.fields.json').length, 2);
  assert.deepEqual(report.sources, [{ id: 'STORE', name: 'Веб-сайт' }]);
  assert.deepEqual(report.contactFields, [{ name: 'fm', type: 'crm_multifield', required: false, readOnly: false }]);
  assert.equal(JSON.stringify(report).includes('private mock data'), false);
  assert.equal(report.categories[0].id, 0); assert.equal(JSON.stringify(report).includes('mock-secret'), false);
  await assert.rejects(inspectBitrix({ webhookUrl: env.BITRIX_WEBHOOK_URL, fetchImpl: () => { throw new Error('private webhook'); } }),
    error => !error.message.includes('private webhook'));
});
