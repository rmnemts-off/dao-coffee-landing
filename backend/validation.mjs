export const directions = Object.freeze({
  drinkx: 'DrinkX', wendougee: 'Wendougee', linkbar: 'LinkBar', coffee: 'Кофе и СТМ',
  'xlvi-ceado': 'XLVI / Ceado', water: 'Водоподготовка', horeca: 'Комплектация',
});
export const sources = Object.freeze({
  'hero-modal': 'Общая модальная форма', 'brand-modal': 'Форма направления', inline: 'Нижняя форма',
});
const allowedFields = new Set(['schemaVersion', 'name', 'phone', 'product', 'interests', 'model', 'comment', 'consent', 'source']);
const has = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const length = value => [...value].length;

export function validateLead(body) {
  const fieldErrors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { fieldErrors: { form: 'Ожидается JSON-объект.' } };
  }
  if (Object.keys(body).some(key => !allowedFields.has(key))) fieldErrors.form = 'Неизвестные поля заявки.';
  if (body.schemaVersion !== 1) fieldErrors.schemaVersion = 'Неподдерживаемая версия формы.';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (length(name) < 2 || length(name) > 100) fieldErrors.name = 'Имя должно содержать от 2 до 100 символов.';
  if (typeof body.phone !== 'string' || !/^\+7\d{10}$/.test(body.phone)) fieldErrors.phone = 'Введите номер полностью: 10 цифр после +7.';
  if (body.product !== null && !has(directions, body.product)) fieldErrors.product = 'Неизвестное направление.';
  const interests = body.interests;
  if (!Array.isArray(interests) || interests.length > 7 || interests.some(id => id !== 'undecided' && !has(directions, id)) ||
      new Set(interests).size !== interests.length ||
      (body.product === null ? interests.length === 0 : interests.length !== 0) ||
      (interests.includes('undecided') && interests.length !== 1)) {
    fieldErrors.interests = 'Выберите направления или только «Помогите определиться».';
  }
  const model = body.model == null ? null : typeof body.model === 'string' ? body.model.trim() : body.model;
  if (model !== null && (typeof model !== 'string' || length(model) > 120)) fieldErrors.model = 'Модель должна содержать не более 120 символов.';
  const comment = body.comment === undefined ? '' : body.comment;
  if (typeof comment !== 'string' || length(comment) > 1000) fieldErrors.comment = 'Комментарий должен содержать не более 1000 символов.';
  if (body.consent !== true) fieldErrors.consent = 'Отметьте согласие на обработку персональных данных.';
  if (!has(sources, body.source) || (body.source === 'brand-modal') !== (body.product !== null)) fieldErrors.source = 'Неверный контекст формы.';
  for (const field of ['name', 'model', 'comment']) {
    const value = body[field];
    if (typeof value === 'string' && (value.includes('\0') || !value.isWellFormed())) {
      fieldErrors[field] = 'Текст содержит недопустимые символы.';
    }
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  return { lead: { schemaVersion: 1, name, phone: body.phone, product: body.product,
    interests: [...interests].sort(), model: model || null, comment: comment.trim(), consent: true, source: body.source } };
}
