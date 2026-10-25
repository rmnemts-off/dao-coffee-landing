import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBitrixSender } from '../bitrix.mjs';
import { createPersistentLeadService } from '../delivery.mjs';
import { openLeadStore } from '../store.mjs';
import { validateLead } from '../validation.mjs';

const env = { BITRIX_WEBHOOK_URL: 'https://crm.example/rest/1/mock-secret/', BITRIX_ENTITY_TYPE_ID: '2',
  BITRIX_ASSIGNED_BY_ID: '17', BITRIX_CATEGORY_ID: '0', BITRIX_STAGE_ID: 'NEW', BITRIX_SOURCE_ID: 'STORE' };
const payload = extra => ({ schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: 'drinkx',
  interests: [], model: null, comment: 'Как подключить воду? Нужны технические данные.', consent: true,
  source: 'brand-modal', ...extra });
function crmMock() {
  const contacts = [], deals = [];
  return { contacts, deals, fetchImpl: async (url, options) => {
    const { entityTypeId, fields, values } = JSON.parse(options.body);
    if (url.endsWith('/crm.duplicate.findbycomm.json')) return Response.json({ result: {
      CONTACT: contacts.filter(x => x.fields.fm[0].value === values[0]).map(x => x.id),
    } });
    assert.ok(url.endsWith('/crm.item.add.json'), 'never update existing contacts/deals');
    const items = entityTypeId === 3 ? contacts : deals;
    const item = { id: items.length + (entityTypeId === 3 ? 100 : 200), fields };
    items.push(item);
    return Response.json({ result: { item: { id: item.id } } });
  } };
}

test('every product arrives in one funnel with visible equipment, originating block and full question', async () => {
  const crm = crmMock(), send = createBitrixSender({ env, fetchImpl: crm.fetchImpl });
  for (const [product, label] of Object.entries({ drinkx: 'DrinkX', wendougee: 'Wendougee', linkbar: 'LinkBar',
    coffee: 'Кофе и СТМ', 'xlvi-ceado': 'XLVI / Ceado', water: 'Водоподготовка', horeca: 'Комплектация' })) {
    const { lead } = validateLead(payload({ product }));
    assert.equal((await send(lead, randomUUID())).kind, 'delivered');
    const { fields } = crm.deals.at(-1);
    assert.equal(fields.title, `Сайт DAO — ${label}`);
    assert.ok(fields.comments.includes(`Блок сайта: Блок ${label} (#${product})`));
    assert.ok(fields.comments.includes(`Вопрос клиента: ${lead.comment}`));
    assert.ok(fields.sourceDescription.includes(`#${product}`));
    assert.equal(fields.categoryId, 0); assert.equal(fields.stageId, 'NEW');
    assert.equal(fields.sourceId, 'STORE'); assert.equal(fields.assignedById, 17);
    assert.deepEqual(fields.contactIds, [100]);
  }
  assert.equal(crm.contacts.length, 1); assert.equal(crm.deals.length, 7);
});

test('general multi-interest title keeps equipment while the source remains hero or contact', async () => {
  const crm = crmMock(), send = createBitrixSender({ env, fetchImpl: crm.fetchImpl });
  for (const [source, anchor] of [['hero-modal', 'hero'], ['inline', 'contact']]) {
    const { lead } = validateLead(payload({ product: null, interests: ['linkbar', 'drinkx'], source }));
    await send(lead, randomUUID());
    const { fields } = crm.deals.at(-1);
    assert.equal(fields.title, 'Сайт DAO — DrinkX, LinkBar');
    assert.ok(fields.comments.includes(`(#${anchor})`));
    assert.ok(fields.sourceDescription.includes(`(#${anchor})`));
    assert.ok(!fields.comments.includes('Блок сайта: Блок DrinkX'));
  }
  await send(validateLead(payload({ product: null, interests: ['undecided'], source: 'hero-modal', comment: '' })).lead, randomUUID());
  const { fields } = crm.deals.at(-1);
  assert.equal(fields.title, 'Сайт DAO — Нужен совет');
  assert.match(fields.comments, /Модель: Не выбрана/); assert.match(fields.comments, /Вопрос клиента: Не указан/);
});

test('explicit model is shown in the title; technical question is kept verbatim and never inferred as a new funnel', async () => {
  const crm = crmMock(), send = createBitrixSender({ env, fetchImpl: crm.fetchImpl });
  const { lead } = validateLead(payload({ model: 'S100\n  тест', comment: '<b>Техвопрос</b> [url=bad]Данные[/url]' }));
  await send(lead, randomUUID());
  const { fields } = crm.deals[0];
  assert.equal(fields.title, 'Сайт DAO — DrinkX — S100 тест');
  assert.match(fields.comments, /&lt;b&gt;Техвопрос/); assert.match(fields.comments, /&#91;url=bad&#93;/);
  assert.equal(fields.categoryId, 0); assert.equal(fields.typeId, undefined);
});

test('two intentional product inquiries share a contact but preserve independent journal snapshots and deals', async t => {
  const crm = crmMock(), store = openLeadStore(); t.after(() => store.close());
  const service = createPersistentLeadService({ store, send: createBitrixSender({ env, fetchImpl: crm.fetchImpl }) });
  const drinkx = payload(), linkbar = payload({ product: 'linkbar', name: 'Тест другое имя', comment: 'Размеры под стойкой?' });
  const key = randomUUID();
  const a = await service.submit(drinkx, key), b = await service.submit(linkbar, randomUUID());
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.body.requestId, b.body.requestId);
  assert.deepEqual(await service.submit(drinkx, key), a);
  assert.equal(crm.contacts.length, 1); assert.equal(crm.contacts[0].fields.name, 'Тест');
  assert.equal(crm.deals.length, 2); assert.notEqual(crm.deals[0].id, crm.deals[1].id);
  for (const [response, product, name] of [[a, 'drinkx', 'Тест'], [b, 'linkbar', 'Тест другое имя']]) {
    const row = store.get(response.body.requestId), snapshot = JSON.parse(row.payload_json);
    assert.equal(snapshot.product, product); assert.equal(snapshot.name, name);
    assert.equal(row.contact_id, 100); assert.equal(row.state, 'delivered');
    assert.equal(crm.deals.find(x => x.id === row.crm_id).fields.originId, row.request_id);
  }
});
