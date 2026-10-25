import test from 'node:test';
import assert from 'node:assert/strict';
import { bitrixConfig, createBitrixSender, formatComments, inspectBitrix, parseWebhook } from '../bitrix.mjs';

const env = { BITRIX_WEBHOOK_URL: 'https://crm.example/rest/1/mock-secret/', BITRIX_ENTITY_TYPE_ID: '1',
  BITRIX_ASSIGNED_BY_ID: '7', BITRIX_STAGE_ID: 'NEW' };
const dealEnv = { ...env, BITRIX_ENTITY_TYPE_ID: '2', BITRIX_CATEGORY_ID: '4', BITRIX_STAGE_ID: 'C4:NEW' };
const lead = { name: 'Тест', phone: '+70000000001', product: 'drinkx', interests: [], model: 'S100',
  comment: '', consent: true, source: 'brand-modal' };
const created = id => Response.json({ result: { item: { id } } });

test('Bitrix configuration requires an explicit destination and never falls back to Telegram', async () => {
  for (const config of [{}, { TELEGRAM_BOT_TOKEN: '1:legacy', TELEGRAM_CHAT_ID: '123' },
    { ...env, BITRIX_ENTITY_TYPE_ID: '' }, { ...env, BITRIX_ENTITY_TYPE_ID: '128' },
    { ...env, BITRIX_ASSIGNED_BY_ID: '0' }, { ...env, BITRIX_STAGE_ID: '' },
    { ...dealEnv, BITRIX_CATEGORY_ID: '' }, { ...env, BITRIX_WEBHOOK_URL: 'http://crm.example/rest/1/secret/' },
    { ...env, BITRIX_SOURCE_ID: '<invalid>' }]) {
    assert.equal(bitrixConfig(config), null);
    assert.deepEqual(await createBitrixSender({ env: config, fetchImpl: () => assert.fail('must not send') })(lead, 'id'), { kind: 'unconfigured' });
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
    assert.equal(fields.name, lead.name); assert.deepEqual(fields.fm, [{ typeId: 'PHONE', valueType: 'WORK', value: lead.phone }]);
    assert.equal(fields.originId, 'request-id'); assert.equal(fields.originatorId, 'DAO_COFFEE_WEBSITE');
    assert.match(fields.comments, /DrinkX/); assert.match(fields.comments, /S100/);
    assert.equal(fields.statusId, undefined); assert.equal(fields.categoryId, undefined);
    return created(42);
  } });
  assert.deepEqual(await send(lead, 'request-id'), { kind: 'delivered' });
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
    assert.match(body.fields.comments, /\+70000000001/);
    return created('99');
  } });
  assert.deepEqual(await send(lead, 'id'), { kind: 'delivered' }); assert.equal(calls.length, 2);
});

test('new contact precedes the deal; a contact alone is never reported as a delivered lead', async () => {
  for (const succeed of [true, false]) {
    let calls = 0;
    const send = createBitrixSender({ env: dealEnv, fetchImpl: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if (calls === 1) return Response.json({ result: [] });
      if (calls === 2) { assert.equal(body.entityTypeId, 3); assert.equal(body.fields.fm[0].value, lead.phone); return created(23); }
      assert.equal(body.entityTypeId, 2); assert.deepEqual(body.fields.contactIds, [23]);
      return succeed ? created(42) : Response.json({ error: 'ACCESS_DENIED', error_description: 'secret CRM data' });
    } });
    assert.equal((await send(lead, 'id')).kind, succeed ? 'delivered' : 'rejected'); assert.equal(calls, 3);
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

test('inspection uses only read methods and returns configuration metadata, not customers or credentials', async () => {
  const seen = [];
  const report = await inspectBitrix({ webhookUrl: env.BITRIX_WEBHOOK_URL, fetchImpl: async (url, options) => {
    const method = url.split('/').at(-1); seen.push(method);
    assert.equal(options.redirect, 'error');
    if (method === 'crm.settings.mode.get.json') return Response.json({ result: 2 });
    if (method === 'crm.item.fields.json') return Response.json({ result: { fields: { title: { type: 'string', isRequired: false, isReadOnly: false } } } });
    if (method === 'crm.status.list.json') return Response.json({ result: [{ STATUS_ID: 'NEW', NAME: 'Новая' }] });
    if (method === 'crm.category.list.json') return Response.json({ result: { categories: [{ id: 0, name: 'Продажи', isDefault: 'Y' }] } });
    assert.fail('unexpected method');
  } });
  assert.equal(seen.length, 4); assert.equal(report.suggestedEntityTypeId, 2);
  assert.equal(report.categories[0].id, 0); assert.equal(JSON.stringify(report).includes('mock-secret'), false);
  await assert.rejects(inspectBitrix({ webhookUrl: env.BITRIX_WEBHOOK_URL, fetchImpl: () => { throw new Error('private webhook'); } }),
    error => !error.message.includes('private webhook'));
});
