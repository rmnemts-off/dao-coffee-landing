import { directions, sources } from './validation.mjs';

// Only server configuration can select the destination. Never take a webhook
// URL, CRM fields, assignee, category or entity type from a browser request.
export function parseWebhook(value = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !/^\/rest\/[1-9]\d*\/[A-Za-z0-9_-]+\/$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function integer(value, minimum = 1) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+$/.test(String(value ?? ''))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

export function bitrixConfig(env = {}) {
  const webhookUrl = parseWebhook(env.BITRIX_WEBHOOK_URL);
  const entityTypeId = integer(env.BITRIX_ENTITY_TYPE_ID);
  const assignedById = integer(env.BITRIX_ASSIGNED_BY_ID);
  const categoryId = integer(env.BITRIX_CATEGORY_ID, 0);
  const stageId = env.BITRIX_STAGE_ID;
  const sourceId = env.BITRIX_SOURCE_ID;
  if (!webhookUrl || ![1, 2].includes(entityTypeId) || !assignedById ||
    typeof stageId !== 'string' || !/^[A-Za-z0-9_:.-]{1,100}$/.test(stageId) ||
    (entityTypeId === 2 && categoryId === null) ||
    typeof sourceId !== 'string' || !/^[A-Za-z0-9_:.-]{1,100}$/.test(sourceId)) return null;
  return { webhookUrl, entityTypeId, assignedById, stageId, sourceId,
    ...(entityTypeId === 2 ? { categoryId } : {}) };
}

// CRM comments can interpret HTML/BBCode. Visitor text must stay text.
const escape = value => String(value).replace(/[&<>"'\[\]]/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '[': '&#91;', ']': '&#93;' })[char]);
export function formatComments(lead, requestId) {
  const interests = lead.product ? directions[lead.product] : lead.interests.map(id => id === 'undecided' ? 'Помогите определиться' : directions[id]).join(', ');
  return [
    `Номер заявки: ${escape(requestId)}`, `Имя: ${escape(lead.name)}`, `Телефон: ${escape(lead.phone)}`,
    `Направления: ${escape(interests)}`, `Модель: ${escape(lead.model || 'Не выбрана')}`,
    `Комментарий: ${escape(lead.comment || 'Не указан')}`, `Форма: ${escape(sources[lead.source])}`,
    'Согласие на обработку данных: передано формой (true)',
  ].join('\n');
}

const originatorId = 'DAO_COFFEE_WEBSITE';
const methods = new Set(['crm.item.add', 'crm.item.list', 'crm.duplicate.findbycomm', 'crm.settings.mode.get', 'crm.item.fields', 'crm.category.list', 'crm.status.list']);
const denied = new Set(['ACCESS_DENIED', 'NO_AUTH_FOUND', 'INVALID_CREDENTIALS', 'insufficient_scope', 'ERROR_METHOD_NOT_FOUND', 'INVALID_REQUEST', 'NOT_FOUND', 'CRM_FIELD_ERROR_VALUE_NOT_VALID']);
const limited = new Set(['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'OVERLOAD_LIMIT']);
class DeliveryError extends Error {
  constructor(kind, retryAfter = 5) { super('Bitrix request failed'); this.kind = kind; this.retryAfter = retryAfter; }
}

async function call(webhookUrl, method, params, signal, fetchImpl, includePagination = false) {
  if (!methods.has(method)) throw new DeliveryError('unconfigured');
  signal.throwIfAborted();
  const response = await fetchImpl(`${webhookUrl}${method}.json`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  signal.throwIfAborted();
  const data = await response.json();
  signal.throwIfAborted();
  const error = data?.error;
  if (limited.has(error)) throw new DeliveryError('rejected', 60);
  if (denied.has(error) || (typeof error === 'string' && response.status >= 400 && response.status < 500)) {
    const retry = Number(response.headers?.get('retry-after'));
    throw new DeliveryError('rejected', response.status === 429 ? Math.min(3600, Math.max(1, retry || 60)) : 5);
  }
  if (!response.ok || !data || typeof data !== 'object' || 'error' in data || 'error_description' in data || !Object.hasOwn(data, 'result')) {
    throw new DeliveryError('uncertain');
  }
  return includePagination ? { result: data.result, total: data.total, next: data.next } : data.result;
}

async function deadline(timeoutMs, operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DeliveryError('uncertain')); }, timeoutMs);
  });
  try { return await Promise.race([timeout, operation(controller.signal)]); }
  finally { clearTimeout(timer); }
}

function createdId(result) {
  const id = integer(result?.item?.id);
  if (!id) throw new DeliveryError('uncertain');
  return id;
}

// One total deadline covers lookup/contact/card creation. No automatic retries,
// no Telegram fallback, no implicit choice of CRM mode or funnel.
export function createBitrixSender({ env = {}, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const config = bitrixConfig(env);
  return async (lead, requestId) => {
    if (!config) return { kind: 'unconfigured' };
    try {
      return await deadline(timeoutMs, async signal => {
        const request = (method, params) => call(config.webhookUrl, method, params, signal, fetchImpl);
        const fields = {
          title: `DAO — ${lead.product ? directions[lead.product] : 'Общая заявка'}`,
          comments: formatComments(lead, requestId), assignedById: config.assignedById,
          originatorId, originId: requestId, sourceId: config.sourceId, opened: 'N',
        };
        const fm = [{ typeId: 'PHONE', valueType: 'WORK', value: lead.phone }];
        let contactId;
        if (config.entityTypeId === 1) {
          Object.assign(fields, { name: lead.name, fm, stageId: config.stageId });
        } else {
          const found = await request('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type: 'PHONE', values: [lead.phone] });
          // No match may be encoded as [] or an empty object by the portal.
          if (!found || typeof found !== 'object' || (Array.isArray(found) && found.length)) throw new DeliveryError('uncertain');
          const ids = found.CONTACT ?? [];
          if (!Array.isArray(ids) || ids.some(id => !integer(id))) throw new DeliveryError('uncertain');
          const contacts = [...new Set(ids.map(Number))];
          // Multiple existing matches need operator review; never attach a
          // visitor's message to an arbitrary person's CRM record.
          if (contacts.length > 1) throw new DeliveryError('rejected');
          contactId = contacts[0] || createdId(await request('crm.item.add', {
            entityTypeId: 3, fields: { name: lead.name, fm, assignedById: config.assignedById, sourceId: config.sourceId, opened: 'N',
              originatorId, originId: `${requestId}:contact` },
          }));
          Object.assign(fields, { contactIds: [contactId], categoryId: config.categoryId, stageId: config.stageId });
        }
        const crmId = createdId(await request('crm.item.add', { entityTypeId: config.entityTypeId, fields }));
        return { kind: 'delivered', entityTypeId: config.entityTypeId, crmId,
          ...(contactId ? { contactId } : {}) };
      });
    } catch (error) {
      // Never expose exception text, webhook URL or raw CRM data to the caller.
      return error instanceof DeliveryError && error.kind === 'rejected'
        ? { kind: 'rejected', retryAfter: error.retryAfter } : { kind: 'uncertain' };
    }
  };
}

// originId is a trace marker, not a CRM uniqueness constraint. After an
// uncertain write only an unambiguous read confirms delivery; zero matches
// never authorize another add, since the earlier request may still complete.
export function createBitrixReconciler({ env = {}, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const config = bitrixConfig(env);
  return async requestId => {
    if (!config) return { kind: 'unconfigured' };
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) return { kind: 'uncertain' };
    try {
      return await deadline(timeoutMs, async signal => {
        const { result, total, next } = await call(config.webhookUrl, 'crm.item.list', {
          entityTypeId: config.entityTypeId,
          filter: { '=originatorId': originatorId, '=originId': requestId },
          select: ['id', 'contactIds'], start: 0,
        }, signal, fetchImpl, true);
        // Bitrix pages contain up to 50 items. Inspect only the first page:
        // total and next are sufficient to reject every ambiguous result.
        if (!Array.isArray(result?.items) || result.items.length !== 1 || integer(total, 0) !== 1 || next !== undefined) {
          return { kind: 'uncertain' };
        }
        const item = result.items[0];
        const crmId = integer(item?.id);
        const contacts = item?.contactIds ?? [];
        if (!crmId || !Array.isArray(contacts) || contacts.some(id => !integer(id))) return { kind: 'uncertain' };
        const contactIds = [...new Set(contacts.map(Number))];
        return { kind: 'delivered', entityTypeId: config.entityTypeId, crmId,
          ...(contactIds.length === 1 ? { contactId: contactIds[0] } : {}) };
      });
    } catch {
      // Even a definite read failure cannot prove that the earlier write
      // failed. Keep it uncertain and never leak raw CRM errors or secrets.
      return { kind: 'uncertain' };
    }
  };
}

function fieldMetadata(result) {
  if (!result?.fields || typeof result.fields !== 'object' || Array.isArray(result.fields)) throw new Error();
  return Object.entries(result.fields).map(([name, field]) => ({
    name, type: field.type, required: field.isRequired, readOnly: field.isReadOnly,
  }));
}

// Read-only setup helper: deliberately excludes create/update methods.
export async function inspectBitrix({ webhookUrl, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = parseWebhook(webhookUrl);
  if (!url) throw new Error('Set a valid BITRIX_WEBHOOK_URL in the local .env.');
  try {
    const request = (method, params = {}) => deadline(timeoutMs, signal => call(url, method, params, signal, fetchImpl));
    const mode = await request('crm.settings.mode.get');
    if (![1, 2].includes(mode)) throw new Error();
    const entityTypeId = mode === 1 ? 1 : 2;
    const fields = await request('crm.item.fields', { entityTypeId });
    const contactFields = await request('crm.item.fields', { entityTypeId: 3 });
    const stages = await request('crm.status.list', { filter: { ENTITY_ID: mode === 1 ? 'STATUS' : 'DEAL_STAGE' } });
    const sourceList = await request('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
    const report = { mode, suggestedEntityTypeId: entityTypeId,
      fields: fieldMetadata(fields), contactFields: fieldMetadata(contactFields),
      defaultStages: stages.map(stage => ({ id: stage.STATUS_ID, name: stage.NAME })),
      sources: sourceList.map(source => ({ id: source.STATUS_ID, name: source.NAME })),
    };
    if (mode === 2) {
      const result = await request('crm.category.list', { entityTypeId: 2 });
      report.categories = result.categories.map(category => ({ id: category.id, name: category.name, isDefault: category.isDefault }));
    }
    return report;
  } catch { throw new Error('Bitrix inspection failed. Check REST subscription, CRM permissions and webhook configuration.'); }
}
