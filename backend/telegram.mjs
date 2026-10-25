import { directions, sources } from './validation.mjs';

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function formatLead(lead, requestId) {
  const interests = lead.product ? directions[lead.product] : lead.interests.map(id => id === 'undecided' ? 'Помогите определиться' : directions[id]).join(', ');
  return [
    '<b>Заявка DAO COFFEE GROUP</b>',
    `Номер: ${escape(requestId)}`, `Имя: ${escape(lead.name)}`, `Телефон: ${escape(lead.phone)}`,
    `Направления: ${escape(interests)}`, `Модель: ${escape(lead.model || 'Не выбрана')}`,
    `Комментарий: ${escape(lead.comment || 'Не указан')}`, `Источник: ${escape(sources[lead.source])}`,
    'Согласие на обработку данных: получено',
  ].join('\n');
}

// The URL and upstream errors contain credentials / personal data. Never log them.
// No retries: Telegram sendMessage has no idempotency key.
export function createTelegramSender({ token = '', chatId = '', timeoutMs = 8000, fetchImpl = fetch } = {}) {
  return async (lead, requestId) => {
    if (!/^\d+:[\w-]+$/.test(token) || !/^(?:-?\d+|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(chatId)) return { kind: 'unconfigured' };
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ kind: 'uncertain' }); }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        try {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: formatLead(lead, requestId), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
          });
          const result = await response.json();
          if (response.ok && result?.ok === true && Number.isSafeInteger(result.result?.message_id) && result.result.message_id > 0) return { kind: 'delivered' };
          // Explicit 4xx rejections are safe to retry manually; 5xx/invalid replies may follow a send.
          if (result?.ok === false && Number.isInteger(result.error_code) && result.error_code >= 400 && result.error_code < 500) {
            return { kind: 'rejected', retryAfter: result.error_code === 429 ? Math.min(3600, Math.max(1, Number(result.parameters?.retry_after) || 60)) : 5 };
          }
          return { kind: 'uncertain' };
        } catch {
          return { kind: 'uncertain' };
        }
      })()]);
    } finally { clearTimeout(timer); }
  };
}
