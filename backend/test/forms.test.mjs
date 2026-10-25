import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../../site/scripts/forms.js', import.meta.url), 'utf8');
const effectsCode = await readFile(new URL('../../site/scripts/effects.js', import.meta.url), 'utf8');
const mainCode = await readFile(new URL('../../site/scripts/main.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const success = () => Response.json({ ok: true, requestId: 'test-request-id' });
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('Form did not reach the expected state');
};
const finished = form => waitFor(() => form.dataset.state !== 'sending');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function setup(t, fetchImpl = async () => success(), { shortTimeout = false, savedStorage = {}, storageBlocked = false, hashingAvailable = true, withPageScripts = false } = {}) {
  // Exercise the actual HTML hooks + shipped script, not a copy of form logic.
  // JSDOM never loads resources; all fetch calls are explicitly mocked.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:4322/', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.matchMedia = query => ({
    matches: withPageScripts ? query.includes('hover: hover') || query.includes('min-width') : true,
    addEventListener() {}, removeEventListener() {},
  });
  if (withPageScripts) {
    // Layout/observer APIs are browser services, not application behavior. The
    // shipped page scripts still register their actual event handlers below.
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve() } });
  }
  window.AbortController = AbortController;
  window.TextEncoder = TextEncoder;
  Object.defineProperty(window, 'crypto', { value: hashingAvailable ? webcrypto : {
    randomUUID: webcrypto.randomUUID.bind(webcrypto), getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  } });
  for (const [key, value] of Object.entries(savedStorage)) window.sessionStorage.setItem(key, value);
  if (storageBlocked) Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage is disabled'); } });
  const calls = [];
  window.fetch = (url, options) => { calls.push({ url, ...options, payload: JSON.parse(options.body) }); return fetchImpl(url, options); };
  if (shortTimeout) {
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms) => real(fn, ms === 20_000 ? 15 : ms);
  }
  const dialog = window.document.querySelector('#project-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  window.eval(code);
  if (withPageScripts) { window.eval(effectsCode); window.eval(mainCode); }
  const inline = window.document.querySelector('#project-form');
  const modal = window.document.querySelector('#dialog-form');
  const change = (field, type = 'input') => field.dispatchEvent(new window.Event(type, { bubbles: true }));
  const fill = (form, comment = 'Тест без отправки в CRM') => {
    form.elements.name.value = 'Тест'; change(form.elements.name);
    form.elements.phone.value = '80000000001'; change(form.elements.phone);
    form.elements.comment.value = comment; change(form.elements.comment);
    form.elements.consent.checked = true; change(form.elements.consent, 'change');
  };
  const open = product => {
    const trigger = [...window.document.querySelectorAll('[data-product]')].find(node => node.dataset.product === product);
    assert.ok(trigger, `CTA for ${product}`);
    trigger.click(); return trigger;
  };
  const close = async () => { dialog.querySelector('.dialog-close').click(); await waitFor(() => !dialog.open); };
  const submit = form => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const storageSnapshot = () => Object.fromEntries(Object.keys(window.sessionStorage).map(key => [key, window.sessionStorage.getItem(key)]));
  return { window, dialog, inline, modal, change, fill, open, close, submit, calls, storageSnapshot };
}

test('inline and hero share a draft, normalized phone and a single pending request', async t => {
  let resolve;
  const x = setup(t, () => new Promise(r => { resolve = r; }));
  x.fill(x.inline);
  assert.equal(x.inline.elements.phone.value, '+7 (000) 000-00-01');
  x.open('');
  assert.equal(x.modal.elements.name.value, 'Тест');
  assert.equal(x.modal.elements.phone.value, x.inline.elements.phone.value);
  x.submit(x.modal); x.submit(x.modal); x.submit(x.inline);
  await waitFor(() => x.calls.length === 1);
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, '/api/leads');
  assert.deepEqual(x.calls[0].payload, { schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: null,
    interests: ['undecided'], model: null, comment: 'Тест без отправки в CRM', consent: true, source: 'hero-modal' });
  for (const form of [x.modal, x.inline]) {
    assert.equal(form.querySelector('[type="submit"]').disabled, true);
    assert.equal(form.elements.name.disabled, true);
    assert.equal(form.getAttribute('aria-busy'), 'true');
    assert.match(form.querySelector('.form-status').textContent, /Отправляем/);
  }
  resolve(success()); await finished(x.inline);
  for (const form of [x.modal, x.inline]) {
    assert.equal(form.dataset.state, 'success');
    assert.equal(form.elements.name.disabled, false);
    assert.equal(form.elements.name.value, 'Тест');
    assert.equal(form.querySelector('[type="submit"]').disabled, false);
  }
});

test('all seven actual product CTAs submit their section context through the shipped form', async t => {
  const x = setup(t);
  const expected = {
    drinkx: 'DrinkX', wendougee: 'Wendougee', linkbar: 'LinkBar', coffee: 'Кофе и СТМ',
    'xlvi-ceado': 'XLVI / Ceado', water: 'Водоподготовка', horeca: 'Комплектация',
  };
  const ctas = [...x.window.document.querySelectorAll('main section .product-cta')];
  assert.deepEqual(ctas.map(cta => cta.closest('section').id).sort(), Object.keys(expected).sort());
  for (const [index, cta] of ctas.entries()) {
    const product = cta.closest('section').id;
    const comment = `Запрос из раздела ${product}`;
    assert.equal(cta.dataset.product, expected[product]);
    assert.equal(cta.dataset.model, '');
    cta.click();
    assert.equal(x.dialog.open, true);
    assert.equal(x.modal.elements.product.value, expected[product]);
    assert.equal(x.modal.querySelector('.product-field').hidden, true);
    assert.equal(x.modal.querySelector('.product-field').disabled, true);
    assert.equal(x.modal.querySelector('.selected-model').hidden, true);
    x.fill(x.modal, comment);
    // Use the actual submit button: this also exercises the HTML form hooks
    // and browser submission event path, not only a hand-dispatched event.
    x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
    assert.equal(x.calls.length, index + 1);
    assert.equal(x.calls.at(-1).url, '/api/leads');
    assert.equal(x.calls.at(-1).method, 'POST');
    assert.match(x.calls.at(-1).headers['Idempotency-Key'], uuidPattern);
    assert.deepEqual(x.calls.at(-1).payload, {
      schemaVersion: 1, name: 'Тест', phone: '+70000000001', product,
      interests: [], model: null, comment, consent: true, source: 'brand-modal',
    });
    assert.equal(x.modal.dataset.state, 'success');
    await x.close();
    assert.equal(x.window.document.activeElement, cta);
  }
});

test('late validation errors survive closing and reopening the shared general draft without stealing focus', async t => {
  let resolve;
  const x = setup(t, () => new Promise(r => { resolve = r; }));
  const opener = x.open('');
  x.fill(x.modal);
  // One astral character passes the browser UTF-16 length check but is one
  // code point to server validation; exercise the genuine server-error path.
  x.modal.elements.name.value = '😀'; x.change(x.modal.elements.name);
  x.submit(x.modal);
  await waitFor(() => x.calls.length === 1);
  assert.equal(x.calls.length, 1);
  await x.close();
  assert.equal(x.window.document.activeElement, opener);
  resolve(Response.json({ ok: false, code: 'VALIDATION_ERROR', fieldErrors: { name: 'Имя должно содержать от 2 до 100 символов.' } }, { status: 400 }));
  await tick();
  assert.equal(x.window.document.activeElement, opener, 'a closed modal response must not move focus into the inline form');
  assert.match(x.inline.querySelector('.form-status').textContent, /Проверьте отмеченные поля/);
  assert.equal(x.inline.elements.name.getAttribute('aria-invalid'), 'true');
  x.open('');
  assert.equal(x.modal.elements.name.value, '😀');
  assert.match(x.modal.querySelector('.form-status').textContent, /Проверьте отмеченные поля/);
  assert.equal(x.modal.elements.name.getAttribute('aria-invalid'), 'true');
  assert.equal(x.window.document.activeElement, x.dialog.querySelector('.dialog-close'));
  x.modal.elements.name.value = 'Тест'; x.change(x.modal.elements.name);
  for (const form of [x.modal, x.inline]) {
    assert.equal(form.elements.name.hasAttribute('aria-invalid'), false);
    assert.equal(form.querySelector('.form-status').textContent, '');
  }
});

test('late brand validation errors stay with their draft when the modal changes context', async t => {
  let resolve;
  const x = setup(t, () => new Promise(r => { resolve = r; }));
  x.open('DrinkX'); x.fill(x.modal); x.submit(x.modal);
  await waitFor(() => x.calls.length === 1);
  await x.close();
  x.open('LinkBar'); x.fill(x.modal, 'Отдельная заявка LinkBar');
  x.modal.elements.comment.focus();
  const focused = x.window.document.activeElement;
  resolve(Response.json({ ok: false, code: 'VALIDATION_ERROR', fieldErrors: { phone: 'Проверьте телефон.' } }, { status: 400 }));
  await tick();
  assert.equal(x.window.document.activeElement, focused);
  assert.equal(x.modal.querySelectorAll('[aria-invalid="true"]').length, 0);
  assert.equal(x.modal.querySelector('.form-status').textContent, '');
  assert.equal(x.inline.querySelectorAll('[aria-invalid="true"]').length, 0);
  await x.close(); x.open('DrinkX');
  assert.equal(x.modal.elements.phone.getAttribute('aria-invalid'), 'true');
  assert.match(x.modal.querySelector('.form-status').textContent, /Проверьте отмеченные поля/);
});

test('model context, separate brand drafts, late responses and focus survive modal reuse', async t => {
  let resolve;
  const x = setup(t, () => new Promise(r => { resolve = r; }));
  const drinkx = x.window.document.querySelector('[data-product="DrinkX"]');
  drinkx.dataset.model = 'S400';
  x.open('DrinkX'); x.fill(x.modal, 'Первый черновик'); x.submit(x.modal);
  await waitFor(() => x.calls.length === 1);
  assert.equal(x.calls[0].payload.model, 'S400');
  await x.close();
  assert.equal(x.window.document.activeElement, drinkx);
  assert.equal(x.window.document.body.style.overflow, '');
  x.open('Wendougee'); x.fill(x.modal, 'Второй черновик');
  resolve(success()); await tick();
  assert.equal(x.modal.elements.comment.value, 'Второй черновик');
  assert.equal(x.modal.dataset.state, 'ready');
  assert.equal(x.modal.querySelector('.form-status').textContent, '');
  assert.equal(x.modal.querySelector('[type="submit"]').disabled, false);
  await x.close(); x.open('DrinkX');
  assert.equal(x.modal.elements.comment.value, 'Первый черновик');
  assert.equal(x.modal.dataset.model, 'S400');
  assert.equal(x.modal.dataset.state, 'success');
  await x.close(); drinkx.dataset.model = 'S100'; x.open('DrinkX');
  assert.equal(x.modal.elements.comment.value, '');
  assert.equal(x.modal.dataset.state, 'ready');
});

test('multi-interest mapping and mutually exclusive undecided choice stay intact', async t => {
  const x = setup(t);
  x.fill(x.inline);
  const choices = [...x.inline.querySelectorAll('[name="interests"]')];
  for (const label of ['DrinkX', 'Водоподготовка']) {
    const choice = choices.find(field => field.value === label); choice.checked = true; x.change(choice, 'change');
  }
  assert.equal(choices.find(field => field.value === 'Помогите определиться').checked, false);
  x.submit(x.inline); await finished(x.inline);
  assert.deepEqual(x.calls[0].payload.interests, ['drinkx', 'water']);
  assert.equal(x.calls[0].payload.source, 'inline');
  const undecided = choices.find(field => field.value === 'Помогите определиться');
  undecided.checked = true; x.change(undecided, 'change');
  assert.equal(choices.filter(field => field.checked).length, 1);
});

test('invalid fields and missing consent never invoke fetch', async t => {
  const x = setup(t);
  x.submit(x.inline); assert.equal(x.calls.length, 0);
  assert.equal(x.inline.elements.name.getAttribute('aria-invalid'), 'true');
  x.fill(x.inline); x.inline.elements.consent.checked = false;
  x.submit(x.inline); assert.equal(x.calls.length, 0);
  assert.equal(x.window.document.activeElement, x.inline.elements.consent);
  x.inline.elements.consent.checked = true;
  x.inline.elements.phone.value = '+7 (123)'; x.submit(x.inline);
  assert.equal(x.calls.length, 0);
  assert.equal(x.inline.elements.phone.getAttribute('aria-invalid'), 'true');
});

test('failure and uncertain responses preserve fields, consent, model and interests', async t => {
  for (const [status, body, message] of [
    [502, { ok: false, code: 'DELIVERY_FAILED' }, /не удалось/],
    [503, { ok: false, code: 'DELIVERY_UNAVAILABLE' }, /не удалось/],
    [502, { ok: false, code: 'DELIVERY_UNCERTAIN' }, /могла дойти/],
    [429, { ok: false, code: 'RATE_LIMITED' }, /Подождите минуту/],
    [409, { ok: false, code: 'IDEMPOTENCY_CONFLICT' }, /Данные заявки изменились/],
    [503, { ok: false, code: 'DELIVERY_PENDING' }, /ещё обрабатывается/],
    [200, { ok: true }, /могла дойти/],
    [400, { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { phone: 'wrong' } }, /Проверьте/],
  ]) {
    const x = setup(t, async () => Response.json(body, { status }));
    x.open('DrinkX'); x.fill(x.modal, 'Сохранить'); x.submit(x.modal); await finished(x.modal);
    assert.equal(x.modal.dataset.state, 'error');
    assert.match(x.modal.querySelector('.form-status').textContent, message);
    assert.equal(x.modal.elements.comment.value, 'Сохранить');
    assert.equal(x.modal.elements.consent.checked, true);
    assert.equal(x.modal.elements.product.value, 'DrinkX');
    assert.equal(x.modal.elements.phone.disabled, false);
    assert.equal(x.modal.querySelector('.product-field').disabled, true);
    assert.equal(x.calls.length, 1);
  }
});

test('network timeout aborts, keeps the draft and never automatically retries', async t => {
  const x = setup(t, (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))), { shortTimeout: true });
  x.fill(x.inline); x.submit(x.inline);
  await finished(x.inline);
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].signal.aborted, true);
  assert.match(x.inline.querySelector('.form-status').textContent, /могла дойти/);
  assert.equal(x.inline.elements.name.value, 'Тест');
  assert.equal(x.inline.querySelector('[type="submit"]').disabled, false);
});

test('phone paste, insertion and backspace preserve mask and draft', t => {
  const x = setup(t);
  const phone = x.inline.elements.phone;
  const paste = new x.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '+7 (000) 000-00-01' } });
  phone.dispatchEvent(paste);
  assert.equal(phone.value, '+7 (000) 000-00-01');
  phone.setSelectionRange(phone.value.length, phone.value.length);
  phone.dispatchEvent(new x.window.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
  assert.equal(phone.value, '+7 (000) 000-00-0');
  phone.dispatchEvent(new x.window.InputEvent('beforeinput', { inputType: 'insertText', data: '2', bubbles: true, cancelable: true }));
  assert.equal(phone.value, '+7 (000) 000-00-02');
  x.open(''); assert.equal(x.modal.elements.phone.value, phone.value);
});


test('manual retry after uncertain delivery shares a UUID across general form views', async t => {
  const x = setup(t, async () => Response.json({ ok: false, code: 'DELIVERY_UNCERTAIN' }, { status: 502 }));
  x.fill(x.inline); x.submit(x.inline); await finished(x.inline);
  const key = x.calls[0].headers['Idempotency-Key'];
  assert.match(key, uuidPattern);
  x.open(''); x.submit(x.modal); await finished(x.modal);
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].headers['Idempotency-Key'], key);
  assert.equal(x.calls[1].payload.source, 'hero-modal');
  assert.equal(x.calls[0].payload.source, 'inline');
});

test('timeout and a page reload retain the intent without persisting personal fields', async t => {
  const x = setup(t, (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))), { shortTimeout: true });
  x.open('DrinkX'); x.fill(x.modal, 'Уникальный комментарий'); x.submit(x.modal); await finished(x.modal);
  const key = x.calls[0].headers['Idempotency-Key'];
  const storage = x.storageSnapshot();
  const values = Object.values(storage).join('');
  for (const personal of ['Тест', '70000000001', 'Уникальный комментарий', 'phone', 'comment']) assert.equal(values.includes(personal), false);
  const records = Object.values(JSON.parse(Object.values(storage)[0]));
  assert.equal(records.length, 1);
  assert.match(records[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(records[0].key, key);
  // Drafts deliberately do not survive a page reload. Re-entering the same
  // data resumes its known intent instead of creating another CRM card.
  const reloaded = setup(t, async () => success(), { savedStorage: storage });
  reloaded.open('DrinkX');
  assert.equal(reloaded.modal.elements.name.value, '');
  reloaded.fill(reloaded.modal, 'Уникальный комментарий'); reloaded.submit(reloaded.modal); await finished(reloaded.modal);
  assert.equal(reloaded.calls[0].headers['Idempotency-Key'], key);
  assert.deepEqual(reloaded.storageSnapshot(), {});
});

test('editing a payload or submitting again after success creates a new intent', async t => {
  let accepted = false;
  const x = setup(t, async () => accepted ? success() : Response.json({ ok: false, code: 'DELIVERY_UNCERTAIN' }, { status: 502 }));
  x.open('DrinkX'); x.fill(x.modal, 'Первый'); x.submit(x.modal); await finished(x.modal);
  const firstKey = x.calls[0].headers['Idempotency-Key'];
  x.modal.elements.comment.value = 'Второй'; x.change(x.modal.elements.comment);
  x.submit(x.modal); await finished(x.modal);
  const secondKey = x.calls[1].headers['Idempotency-Key'];
  assert.notEqual(secondKey, firstKey);
  accepted = true;
  x.submit(x.modal); await finished(x.modal);
  assert.equal(x.calls[2].headers['Idempotency-Key'], secondKey);
  x.submit(x.modal); await finished(x.modal);
  assert.notEqual(x.calls[3].headers['Idempotency-Key'], secondKey);
  assert.equal(x.calls[3].payload.product, 'drinkx');
  assert.deepEqual(x.storageSnapshot(), {});
});

test('brand contexts retain independent retry keys while normalizing unchanged values', async t => {
  const x = setup(t, async () => Response.json({ ok: false, code: 'DELIVERY_UNCERTAIN' }, { status: 502 }));
  x.open('DrinkX'); x.fill(x.modal); x.submit(x.modal); await finished(x.modal);
  const firstKey = x.calls[0].headers['Idempotency-Key'];
  await x.close(); x.open('Wendougee'); x.fill(x.modal); x.submit(x.modal); await finished(x.modal);
  assert.notEqual(x.calls[1].headers['Idempotency-Key'], firstKey);
  await x.close(); x.open('DrinkX');
  x.modal.elements.name.value = ' Тест '; x.change(x.modal.elements.name);
  x.submit(x.modal); await finished(x.modal);
  assert.equal(x.calls[2].headers['Idempotency-Key'], firstKey);
});

test('blocked storage or unavailable hashing preserves retry keys in memory', async t => {
  for (const options of [{ storageBlocked: true }, { hashingAvailable: false }]) {
    const x = setup(t, async () => Response.json({ ok: false, code: 'DELIVERY_UNCERTAIN' }, { status: 502 }), options);
    x.fill(x.inline); x.submit(x.inline); await finished(x.inline);
    x.submit(x.inline); await finished(x.inline);
    assert.match(x.calls[0].headers['Idempotency-Key'], uuidPattern);
    assert.equal(x.calls[1].headers['Idempotency-Key'], x.calls[0].headers['Idempotency-Key']);
    if (!options.storageBlocked) assert.deepEqual(x.storageSnapshot(), {});
  }
});


test('pending responses retain the same intent and never show success or trigger a retry', async t => {
  const x = setup(t, async () => Response.json({ ok: false, code: 'DELIVERY_PENDING' }, { status: 503 }));
  x.fill(x.inline); x.submit(x.inline); await finished(x.inline);
  const key = x.calls[0].headers['Idempotency-Key'];
  assert.equal(x.inline.dataset.state, 'error');
  assert.match(x.inline.querySelector('.form-status').textContent, /ещё обрабатывается/);
  assert.equal(x.calls.length, 1);
  x.submit(x.inline); await finished(x.inline);
  assert.equal(x.calls[1].headers['Idempotency-Key'], key);
  assert.equal(x.inline.elements.name.value, 'Тест');
});

test('idempotency conflicts preserve the draft and a corrected payload gets a fresh key', async t => {
  const x = setup(t, async () => Response.json({ ok: false, code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 }));
  x.open('DrinkX'); x.fill(x.modal, 'Сохранить этот текст'); x.submit(x.modal); await finished(x.modal);
  assert.equal(x.modal.dataset.state, 'error');
  assert.equal(x.modal.elements.comment.value, 'Сохранить этот текст');
  assert.equal(x.modal.elements.consent.checked, true);
  assert.match(x.modal.querySelector('.form-status').textContent, /Данные заявки изменились/);
  const key = x.calls[0].headers['Idempotency-Key'];
  x.modal.elements.comment.value += ' — уточнение'; x.change(x.modal.elements.comment);
  x.submit(x.modal); await finished(x.modal);
  assert.notEqual(x.calls[1].headers['Idempotency-Key'], key);
  assert.equal(x.calls[1].payload.product, 'drinkx');
});


test('actual hero and inline submits preserve multiple interests after visiting a brand', async t => {
  const x = setup(t);
  const hero = x.window.document.querySelector('.hero button[data-product]');
  const linkbar = x.window.document.querySelector('#linkbar .product-cta');
  const choices = [...x.inline.querySelectorAll('[name="interests"]')];
  x.fill(x.inline, 'Нужны станции для офиса и водоподготовка');
  for (const label of ['DrinkX', 'Водоподготовка']) choices.find(field => field.value === label).click();
  hero.click();
  assert.equal(x.modal.querySelector('.product-field').hidden, false);
  assert.equal(x.modal.querySelector('.product-field').disabled, false);
  x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
  assert.deepEqual(x.calls[0].payload, {
    schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: null,
    interests: ['drinkx', 'water'], model: null, comment: 'Нужны станции для офиса и водоподготовка',
    consent: true, source: 'hero-modal',
  });
  await x.close(); linkbar.click();
  assert.equal(x.modal.elements.comment.value, '');
  x.fill(x.modal, 'Отдельный вопрос по LinkBar');
  x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
  assert.equal(x.calls[1].payload.product, 'linkbar');
  assert.deepEqual(x.calls[1].payload.interests, []);
  await x.close();
  assert.equal(x.inline.elements.product.value, '');
  assert.equal(x.inline.elements.comment.value, 'Нужны станции для офиса и водоподготовка');
  x.inline.querySelector('button[type="submit"]').click(); await finished(x.inline);
  assert.deepEqual(x.calls[2].payload, { ...x.calls[0].payload, source: 'inline' });
  hero.click();
  const advice = [...x.modal.querySelectorAll('.interest-option')].find(label => label.textContent.trim() === 'Нужен совет');
  assert.ok(advice, 'Current visible advice label must map to the undecided value');
  advice.click();
  x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
  assert.deepEqual(x.calls[3].payload.interests, ['undecided']);
  assert.equal(x.calls[3].payload.product, null);
  assert.equal(x.calls[3].payload.model, null);
  assert.equal(x.calls[3].payload.source, 'hero-modal');
});

test('technical and price questions stay in the comment of the same product request', async t => {
  const x = setup(t);
  x.window.document.querySelector('#drinkx .product-cta').click();
  const questions = [
    'Какое напряжение питания нужно для DrinkX S400 и можно ли подключить систему учёта?',
    'Пришлите прайс на DrinkX S400 для офиса.',
  ];
  for (const question of questions) {
    x.fill(x.modal, question);
    x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
  }
  assert.equal(x.calls.length, 2);
  assert.deepEqual(x.calls[0].payload, {
    schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: 'drinkx',
    interests: [], model: null, comment: questions[0], consent: true, source: 'brand-modal',
  });
  assert.deepEqual(x.calls[1].payload, { ...x.calls[0].payload, comment: questions[1] });
  // Naming a model in free text is not an explicit model selection.
  assert.equal(x.modal.dataset.model, '');
  assert.equal(x.modal.querySelector('.selected-model').hidden, true);
});

test('hovering or clicking informational model cards never invents a selected model', async t => {
  const x = setup(t, async () => success(), { withPageScripts: true });
  const sections = [...x.window.document.querySelectorAll('section')].filter(section => section.querySelector('.model[data-model]'));
  assert.deepEqual(sections.map(section => section.id), ['drinkx', 'wendougee', 'xlvi-ceado']);
  for (const [index, section] of sections.entries()) {
    const cards = [...section.querySelectorAll('.model[data-model]')];
    assert.ok(cards.length > 0);
    for (const card of cards) {
      assert.ok(card.dataset.model, 'The informational card contains a real model name');
      card.dispatchEvent(new x.window.MouseEvent('mouseenter', { bubbles: true }));
      const move = new x.window.MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 20 });
      Object.defineProperty(move, 'pointerType', { value: 'mouse' });
      card.dispatchEvent(move);
      await waitFor(() => card.hasAttribute('data-lit'));
      card.click();
      assert.equal(x.dialog.open, false, 'A model card is not a request CTA');
      assert.equal(x.calls.length, index, 'A hover or informational click cannot submit a request');
      card.dispatchEvent(new x.window.Event('pointerleave'));
    }
    section.querySelector('.product-cta').click();
    x.fill(x.modal);
    x.modal.querySelector('button[type="submit"]').click(); await finished(x.modal);
    assert.equal(x.calls.at(-1).payload.product, section.id);
    assert.equal(x.calls.at(-1).payload.source, 'brand-modal');
    assert.equal(x.calls.at(-1).payload.model, null);
    assert.equal(x.modal.querySelector('.selected-model').hidden, true);
    await x.close();
  }
});
