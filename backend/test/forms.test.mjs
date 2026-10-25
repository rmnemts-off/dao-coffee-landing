import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../../site/scripts/forms.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const success = () => Response.json({ ok: true, requestId: 'test-request-id' });

function setup(t, fetchImpl = async () => success(), { shortTimeout = false } = {}) {
  // Exercise the actual HTML hooks + shipped script, not a copy of form logic.
  // JSDOM never loads resources; all fetch calls are explicitly mocked.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:4322/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.matchMedia = () => ({ matches: true });
  window.AbortController = AbortController;
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
  const inline = window.document.querySelector('#project-form');
  const modal = window.document.querySelector('#dialog-form');
  const change = (field, type = 'input') => field.dispatchEvent(new window.Event(type, { bubbles: true }));
  const fill = (form, comment = 'Тест без отправки в Telegram') => {
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
  const close = async () => { dialog.querySelector('.dialog-close').click(); await tick(); };
  const submit = form => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { window, dialog, inline, modal, change, fill, open, close, submit, calls };
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
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, '/api/leads');
  assert.deepEqual(x.calls[0].payload, { schemaVersion: 1, name: 'Тест', phone: '+70000000001', product: null,
    interests: ['undecided'], model: null, comment: 'Тест без отправки в Telegram', consent: true, source: 'hero-modal' });
  for (const form of [x.modal, x.inline]) {
    assert.equal(form.querySelector('[type="submit"]').disabled, true);
    assert.equal(form.elements.name.disabled, true);
    assert.equal(form.getAttribute('aria-busy'), 'true');
    assert.match(form.querySelector('.form-status').textContent, /Отправляем/);
  }
  resolve(success()); await tick();
  for (const form of [x.modal, x.inline]) {
    assert.equal(form.dataset.state, 'success');
    assert.equal(form.elements.name.disabled, false);
    assert.equal(form.elements.name.value, 'Тест');
    assert.equal(form.querySelector('[type="submit"]').disabled, false);
  }
});

test('every brand carries its id and source; hidden interests are empty', async t => {
  const x = setup(t);
  const directions = { DrinkX: 'drinkx', Wendougee: 'wendougee', LinkBar: 'linkbar', 'Кофе и СТМ': 'coffee', 'XLVI / Ceado': 'xlvi-ceado', 'Водоподготовка': 'water', 'Комплектация': 'horeca' };
  for (const [label, id] of Object.entries(directions)) {
    x.open(label); x.fill(x.modal); x.submit(x.modal); await tick();
    assert.equal(x.calls.at(-1).payload.product, id);
    assert.equal(x.calls.at(-1).payload.source, 'brand-modal');
    assert.deepEqual(x.calls.at(-1).payload.interests, []);
    assert.equal(x.calls.at(-1).payload.model, null);
    assert.equal(x.modal.querySelector('.product-field').disabled, true);
    await x.close();
  }
});

test('model context, separate brand drafts, late responses and focus survive modal reuse', async t => {
  let resolve;
  const x = setup(t, () => new Promise(r => { resolve = r; }));
  const drinkx = x.window.document.querySelector('[data-product="DrinkX"]');
  drinkx.dataset.model = 'S400';
  x.open('DrinkX'); x.fill(x.modal, 'Первый черновик'); x.submit(x.modal);
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
  x.submit(x.inline); await tick();
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
    [200, { ok: true }, /могла дойти/],
    [400, { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { phone: 'wrong' } }, /Проверьте/],
  ]) {
    const x = setup(t, async () => Response.json(body, { status }));
    x.open('DrinkX'); x.fill(x.modal, 'Сохранить'); x.submit(x.modal); await tick();
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
  await new Promise(resolve => setTimeout(resolve, 35));
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
