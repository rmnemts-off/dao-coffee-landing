// Context-specific, in-memory drafts. CRM credentials stay on the server.
(() => {
  const inlineForm = document.querySelector('#project-form');
  const dialog = document.querySelector('#project-dialog');
  const modalForm = inlineForm.cloneNode(true);
  modalForm.id = 'dialog-form';
  modalForm.classList.remove('reveal');
  modalForm.querySelector('h3').id = 'dialog-title';
  dialog.querySelector('.dialog-form-slot').append(modalForm);
  const forms = [inlineForm, modalForm];
  const directions = {
    drinkx: 'DrinkX', wendougee: 'Wendougee', linkbar: 'LinkBar', coffee: 'Кофе и СТМ',
    'xlvi-ceado': 'XLVI / Ceado', water: 'Водоподготовка', horeca: 'Комплектация'
  };
  const general = {
    title: 'Обсудить ваш проект',
    question: 'Что вы планируете открыть или изменить?',
    placeholder: 'Расскажите о формате проекта, городе и том, что хотите запустить или обновить'
  };
  const contexts = {
    DrinkX: {
      title: 'Заявка на DrinkX',
      question: 'Где хотите установить станцию DrinkX?',
      placeholder: 'Место установки, примерный поток гостей и напитки, которые хотите предлагать'
    },
    Wendougee: {
      title: 'Заявка на Wendougee',
      question: 'Какой у вас формат и поток гостей?',
      placeholder: 'Меню, примерный поток и техника, которую хотите установить или заменить'
    },
    LinkBar: {
      title: 'Заявка на LinkBar',
      question: 'Где хотите разместить LinkBar?',
      placeholder: 'Где будет стойка, сколько места под ней и какие напитки хотите готовить'
    },
    'Кофе и СТМ': {
      title: 'Заявка на кофе и СТМ',
      question: 'Как вы планируете использовать кофе?',
      placeholder: 'Кофе для заведения, экстракт или своя марка. Какой вкус и объём вам нужны?'
    },
    'XLVI / Ceado': {
      title: 'Заявка на XLVI / Ceado',
      question: 'Как вы планируете оборудовать кофейный бар?',
      placeholder: 'Формат бара, поток гостей и техника, которую хотите установить или заменить'
    },
    'Водоподготовка': {
      title: 'Заявка на водоподготовку',
      question: 'Где и для какой техники нужна очистка воды?',
      placeholder: 'Источник воды и оборудование на точке. Если есть анализ воды, укажите его'
    },
    'Комплектация': {
      title: 'Подбор и комплектация',
      question: 'Какое заведение нужно оснастить?',
      placeholder: 'Формат заведения, размеры помещения и позиции, которые хотите подобрать'
    }
  };
  const drafts = new Map();
  const deliveries = new Map();
  const lockedFields = new WeakMap();
  const productIds = Object.fromEntries(Object.entries(directions).map(([id, label]) => [label, id]));
  const unknownDelivery = 'Не удалось подтвердить доставку. Заявка могла дойти. Не отправляйте её повторно сразу; свяжитесь с нами по указанным на сайте контактам.';
  inlineForm.dataset.context = 'general';
  modalForm.dataset.context = 'general';
  let opener;
  let previousOverflow;
  let backdropPointer = false;
  let closeTimer;
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  function closeDialog() {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.remove('is-open');
    dialog.classList.add('is-closing');
    const closeMs = motionPreference.matches ? 0 : parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')
    ) || 150;
    closeTimer = setTimeout(() => {
      dialog.close();
      dialog.classList.remove('is-closing');
    }, closeMs);
  }

  function clearFeedback(form) {
    form.querySelector('.form-status').textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    renderDelivery(form);
  }
  function renderDelivery(form) {
    const state = deliveries.get(form.dataset.context);
    const pending = state?.pending === true;
    const locked = lockedFields.get(form);
    if (locked) {
      for (const [field, disabled] of locked) field.disabled = disabled;
      lockedFields.delete(form);
    }
    if (pending) {
      const fields = [...form.querySelectorAll('input, textarea, select')];
      lockedFields.set(form, fields.map(field => [field, field.disabled]));
      for (const field of fields) field.disabled = true;
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = pending;
    button.textContent = pending ? 'Отправляем…' : 'Отправить заявку';
    form.setAttribute('aria-busy', String(pending));
    form.dataset.state = pending ? 'sending' : state?.state || 'ready';
    if (state?.message) form.querySelector('.form-status').textContent = state.message;
  }
  function payloadFor(form) {
    const product = productIds[form.elements.product.value] || null;
    return {
      schemaVersion: 1, name: form.elements.name.value.trim(),
      phone: `+${form.elements.phone.value.replace(/\D/g, '')}`,
      product, interests: product ? [] : [...form.querySelectorAll('[name="interests"]:checked')]
        .map(field => field.value === 'Помогите определиться' ? 'undecided' : productIds[field.value]),
      model: form.dataset.model || null, comment: form.elements.comment.value.trim(),
      consent: form.elements.consent.checked,
      source: form === inlineForm ? 'inline' : product ? 'brand-modal' : 'hero-modal',
    };
  }
  function showFieldErrors(form, errors) {
    const allowed = { name: form.elements.name, phone: form.elements.phone, consent: form.elements.consent,
      comment: form.elements.comment, interests: form.querySelector('.product-field') };
    let first;
    for (const key of Object.keys(errors || {})) {
      const field = Object.hasOwn(allowed, key) ? allowed[key] : null;
      if (!field) continue;
      field.setAttribute('aria-invalid', 'true');
      first ||= key === 'interests' ? field.querySelector('input') : field;
    }
    first?.focus();
  }
  function setModel(form, model = '') {
    form.dataset.model = model;
    const note = form.querySelector('.selected-model');
    note.hidden = !model;
    note.textContent = model ? `Выбранная модель: ${model}` : '';
  }
  function saveDraft(source) {
    const draft = Object.fromEntries(['name', 'phone', 'product', 'comment'].map(name => [name, source.elements[name].value]));
    draft.interests = [...source.querySelectorAll('[name="interests"]:checked')].map(field => field.value);
    draft.consent = source.elements.consent.checked;
    drafts.set(source.dataset.context, draft);
    // Only the general modal and the inline general form share a draft.
    const target = forms.find(form => form !== source);
    if (target.dataset.context === source.dataset.context) restoreDraft(target);
  }
  function restoreDraft(form) {
    const draft = drafts.get(form.dataset.context) || {};
    for (const name of ['name', 'phone', 'product', 'comment']) form.elements[name].value = draft[name] || '';
    form.elements.consent.checked = !!draft.consent;
    for (const field of form.querySelectorAll('[name="interests"]')) {
      field.checked = (draft.interests || ['Помогите определиться']).includes(field.value);
    }
    clearFeedback(form);
  }
  function configureForm(product, model = '') {
    const content = contexts[product] || general;
    modalForm.dataset.context = product ? `${product}:${model}` : 'general';
    restoreDraft(modalForm);
    modalForm.querySelector('h3').textContent = content.title;
    modalForm.querySelector('.comment-label').textContent = content.question;
    modalForm.elements.comment.placeholder = content.placeholder;
    modalForm.querySelector('.product-field').hidden = !!product;
    modalForm.querySelector('.product-field').disabled = !!product;
    if (product) modalForm.elements.product.value = product;
    setModel(modalForm, model);
    renderDelivery(modalForm);
  }

  document.querySelectorAll('[data-product]').forEach(trigger => {
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', dialog.id);
    trigger.addEventListener('click', event => {
      event.preventDefault();
      if (dialog.open) return;
      opener = trigger;
      const product = directions[trigger.closest('.product-section')?.id] || trigger.dataset.product || '';
      configureForm(product, trigger.dataset.model);
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      clearTimeout(closeTimer);
      dialog.classList.remove('is-closing');
      dialog.showModal();
      void dialog.offsetWidth;
      dialog.classList.add('is-open');
      dialog.scrollTop = 0;
      dialog.querySelector('.dialog-close').focus({ preventScroll: true });
    });
  });
  dialog.querySelector('.dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const fields = [...dialog.querySelectorAll('button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea, a[href]')].filter(field => !field.closest('[hidden]'));
    const first = fields[0];
    const last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
  // Close only when the gesture both begins and ends on the backdrop.
  dialog.addEventListener('pointerdown', event => { backdropPointer = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (backdropPointer && event.target === dialog) closeDialog();
    backdropPointer = false;
  });
  dialog.addEventListener('close', () => {
    clearTimeout(closeTimer);
    dialog.classList.remove('is-open', 'is-closing');
    document.body.style.overflow = previousOverflow || '';
    opener?.focus({ preventScroll: true });
  });

  function attachPhoneMask(field) {
    const digits = value => value.replace(/\D/g, '');
    const national = value => {
      const raw = digits(value);
      // A single typed 7 or 8 is a subscriber digit. Strip a country/trunk
      // prefix only from an explicit +7 or a complete pasted 11-digit number.
      return (value.startsWith('+7') || (raw.length === 11 && /^[78]/.test(raw)) ? raw.slice(1) : raw).slice(0, 10);
    };
    const format = (number, active) => {
      if (!number) return active ? '+7' : '';
      let value = `+7 (${number.slice(0, 3)}`;
      if (number.length >= 3) value += ')';
      if (number.length > 3) value += ` ${number.slice(3, 6)}`;
      if (number.length > 6) value += `-${number.slice(6, 8)}`;
      if (number.length > 8) value += `-${number.slice(8, 10)}`;
      return value;
    };
    const offset = position => digits(field.value.slice(field.value.startsWith('+7') ? 2 : 0, Math.max(position, 2))).length;
    function write(number, active, position) {
      field.value = format(number, active);
      let caret = field.value.length;
      let count = 0;
      for (let i = 2; i < field.value.length; i++) {
        if (/\d/.test(field.value[i])) {
          if (count === position) { caret = i; break; }
          count++;
        }
      }
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function insert(text, pasted = false) {
      if (!pasted && !/^[\d+]+$/.test(text)) return;
      const added = pasted ? national(text) : digits(text);
      if (!added && !text.includes('+')) return;
      const current = national(field.value);
      const start = offset(field.selectionStart ?? 0);
      const end = offset(field.selectionEnd ?? 0);
      if (!added) {
        if (!field.value) write('', true, 0);
        return;
      }
      const room = 10 - (current.length - (end - start));
      const accepted = added.slice(0, room);
      write(current.slice(0, start) + accepted + current.slice(end), true, start + accepted.length);
    }
    field.addEventListener('beforeinput', event => {
      if (!event.cancelable) return;
      if (event.inputType === 'insertText' || event.inputType === 'insertCompositionText') {
        event.preventDefault();
        insert(event.data || '', (event.data || '').length > 1);
      } else if (event.inputType.startsWith('delete')) {
        event.preventDefault();
        const current = national(field.value);
        const startPosition = field.selectionStart ?? 0;
        const endPosition = field.selectionEnd ?? startPosition;
        let start = offset(startPosition);
        let end = offset(endPosition);
        const selected = startPosition !== endPosition;
        if (!selected) {
          if (event.inputType.includes('Backward')) start = event.inputType.includes('Word') ? 0 : Math.max(0, start - 1);
          else end = event.inputType.includes('Word') ? current.length : Math.min(current.length, end + 1);
        }
        const remaining = current.slice(0, start) + current.slice(end);
        const cleared = selected && startPosition === 0 && endPosition === field.value.length;
        write(remaining, !cleared && (current.length > 0 || remaining.length > 0), start);
      }
    });
    field.addEventListener('paste', event => {
      event.preventDefault();
      insert(event.clipboardData.getData('text'), true);
    });
    // Fallback for autofill, drag/drop and input methods with no cancellable
    // beforeinput. Normalize before the form saves its shared draft.
    field.addEventListener('input', () => {
      const value = field.value;
      const normalized = format(national(value), value.includes('+') || /\d/.test(value));
      if (value !== normalized) field.value = normalized;
    });
  }

  for (const form of forms) {
    attachPhoneMask(form.elements.phone);
    form.addEventListener('input', event => {
      const state = deliveries.get(form.dataset.context);
      if (!state?.pending) deliveries.delete(form.dataset.context);
      event.target.removeAttribute('aria-invalid');
      form.querySelector('.form-status').textContent = '';
      saveDraft(form);
      renderDelivery(form);
    });
    form.addEventListener('change', event => {
      if (!deliveries.get(form.dataset.context)?.pending) deliveries.delete(form.dataset.context);
      if (event.target.name === 'interests' && event.target.checked) {
        for (const field of form.querySelectorAll('[name="interests"]')) {
          if (field !== event.target && (event.target.value === 'Помогите определиться' || field.value === 'Помогите определиться')) field.checked = false;
        }
      }
      if (event.target.name === 'product') setModel(form);
      clearFeedback(form);
      saveDraft(form);
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const context = form.dataset.context;
      if (deliveries.get(context)?.pending) return;
      const nameValid = form.elements.name.value.trim().length >= 2;
      const phoneValid = /^7\d{10}$/.test(form.elements.phone.value.replace(/\D/g, ''));
      const interestGroup = form.querySelector('.product-field');
      const interestsValid = interestGroup.disabled || !!interestGroup.querySelector('input:checked');
      const consentValid = form.elements.consent.checked;
      const invalid = [];
      for (const [field, valid] of [[form.elements.name, nameValid], [form.elements.phone, phoneValid], [form.elements.consent, consentValid]]) {
        if (!valid) { field.setAttribute('aria-invalid', 'true'); invalid.push(field); }
        else field.removeAttribute('aria-invalid');
      }
      if (!interestsValid) {
        interestGroup.setAttribute('aria-invalid', 'true');
        invalid.push(interestGroup.querySelector('input'));
      } else interestGroup.removeAttribute('aria-invalid');
      const status = form.querySelector('.form-status');
      if (invalid.length) {
        status.textContent = !nameValid ? 'Укажите ваше имя.' : !phoneValid ? 'Введите номер полностью: 10 цифр после +7.' : !consentValid ? 'Отметьте согласие на обработку персональных данных.' : 'Выберите направление или «Помогите определиться».';
        invalid[0].focus();
        return;
      }
      saveDraft(form);
      const payload = payloadFor(form);
      const state = { pending: true, state: 'sending', message: 'Отправляем заявку…' };
      deliveries.set(context, state);
      for (const target of forms) if (target.dataset.context === context) renderDelivery(target);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let fieldErrors;
      try {
        const response = await fetch('/api/leads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', signal: controller.signal, body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.status === 200 && result?.ok === true && typeof result.requestId === 'string' && result.requestId) {
          state.state = 'success';
          state.message = 'Заявка отправлена. Мы свяжемся с вами.';
        } else {
          state.state = 'error';
          if (result?.ok !== false) state.message = unknownDelivery;
          else if (response.status === 400 && result.code === 'VALIDATION_ERROR') {
            state.message = 'Проверьте отмеченные поля. Заявка не отправлена.';
            fieldErrors = result.fieldErrors;
          } else if (response.status === 429) state.message = 'Слишком много попыток. Подождите минуту и попробуйте снова.';
          else if (response.status === 413) state.message = 'Заявка слишком большая. Сократите текст и попробуйте снова.';
          else if (result.code === 'DELIVERY_UNCERTAIN') state.message = unknownDelivery;
          else if (['DELIVERY_FAILED', 'DELIVERY_UNAVAILABLE'].includes(result.code)) state.message = 'Отправить заявку сейчас не удалось. Попробуйте позже или свяжитесь с нами по контактам на сайте.';
          else state.message = unknownDelivery;
        }
      } catch {
        state.state = 'error';
        state.message = unknownDelivery;
      } finally {
        clearTimeout(timer);
        state.pending = false;
        for (const target of forms) if (target.dataset.context === context) renderDelivery(target);
        // A closed/reused modal must not steal focus or receive another context's errors.
        if (fieldErrors && form.dataset.context === context && (form === inlineForm || dialog.open)) showFieldErrors(form, fieldErrors);
      }
    });
    // Without JS, the inline submit remains disabled and cannot send a GET request.
    form.querySelector('[type="submit"]').disabled = false;
  }
})();
