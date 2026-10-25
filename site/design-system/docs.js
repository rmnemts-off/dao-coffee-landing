// Interactions of the design system page itself: copying colours, contrast
// figures, chapter navigation, the "no motion" preview, demo-only motion and
// the demo form. Shared brand effects come from /scripts/effects.js.
(() => {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const toast = document.querySelector('#toast');
  let toastTimer;
  function say(message) {
    toast.textContent = message;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1800);
  }

  // Copy a colour value from an arch or a chip.
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        say(`Скопировано: ${value}`);
      } catch {
        say(value);
      }
    });
  });

  // WCAG contrast for each listed pair, alpha blended over the background.
  const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = channels => {
    const [r, g, b] = channels.map(value => {
      value /= 255;
      return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  document.querySelectorAll('.contrast').forEach(row => {
    const background = rgb(row.dataset.bg);
    const alpha = Number(row.dataset.fgAlpha || 1);
    const foreground = rgb(row.dataset.fg).map((value, index) => value * alpha + background[index] * (1 - alpha));
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    const ratio = (light + .05) / (dark + .05);
    const verdict = ratio >= 4.5 ? 'текст' : ratio >= 3 ? 'крупный текст' : 'не для текста';
    row.classList.toggle('fail', ratio < 3);
    row.querySelector('.ratio').innerHTML = `${ratio.toFixed(2).replace('.', ',')}:1<small>${verdict}</small>`;
  });

  // Highlight the chapter in view; the dot walks down the dashed trail.
  const links = new Map(Array.from(document.querySelectorAll('.ds-nav a')).map(link => [link.hash.slice(1), link]));
  const chapters = Array.from(document.querySelectorAll('.ds-chapter'));
  let current;
  const mark = id => {
    if (id === current) return;
    current = id;
    links.forEach((link, key) => {
      if (key === id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    const active = links.get(id);
    const strip = active?.closest('ol');
    if (strip && getComputedStyle(strip).display === 'flex') {
      strip.scrollTo({ left: active.offsetLeft - 16, behavior: 'smooth' });
    }
  };
  const visible = new Set();
  const chapterObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target));
    const first = chapters.find(chapter => visible.has(chapter));
    if (first) mark(first.id);
  }, { rootMargin: '-35% 0px -55% 0px' });
  chapters.forEach(chapter => chapterObserver.observe(chapter));

  // Preview the page as it looks without motion.
  document.querySelector('#motion-off').addEventListener('change', event => {
    root.toggleAttribute('data-motion-off', event.target.checked);
    document.querySelectorAll('[data-lit]').forEach(element => element.removeAttribute('data-lit'));
    say(event.target.checked ? 'Движение выключено' : 'Движение включено');
  });

  // Demo-only motion that the landing runs through GSAP in main.js.
  const revealing = document.querySelectorAll('[data-reveal]');
  if (reduced.matches) revealing.forEach(element => element.classList.add('is-in'));
  else {
    const revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealObserver.unobserve(entry.target);
        entry.target.classList.add('is-in');
      }
    }, { threshold: .15 });
    revealing.forEach(element => revealObserver.observe(element));
  }
  document.querySelectorAll('[data-follow]').forEach(area => {
    const images = area.querySelectorAll('img');
    area.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !finePointer.matches || reduced.matches || root.hasAttribute('data-motion-off')) return;
      const box = area.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1)) * 6;
      const y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1)) * 5;
      images.forEach(image => { image.style.setProperty('--fx', `${x.toFixed(2)}px`); image.style.setProperty('--fy', `${y.toFixed(2)}px`); });
    });
    area.addEventListener('pointerleave', () => images.forEach(image => { image.style.removeProperty('--fx'); image.style.removeProperty('--fy'); }));
  });

  // Demo form: the same rules and messages as the landing form, nothing is sent.
  const form = document.querySelector('#ds-form');
  const phone = form.elements.phone;
  phone.addEventListener('input', () => {
    let digits = phone.value.replace(/\D/g, '');
    if (phone.value.startsWith('+7') || (digits.length === 11 && /^[78]/.test(digits))) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    let masked = digits ? `+7 (${digits.slice(0, 3)}` : '';
    if (digits.length >= 3) masked += ')';
    if (digits.length > 3) masked += ` ${digits.slice(3, 6)}`;
    if (digits.length > 6) masked += `-${digits.slice(6, 8)}`;
    if (digits.length > 8) masked += `-${digits.slice(8, 10)}`;
    phone.value = masked;
  });
  const status = form.querySelector('.form-status');
  form.addEventListener('change', event => {
    if (event.target.name === 'interests' && event.target.checked) {
      for (const field of form.querySelectorAll('[name="interests"]')) {
        if (field !== event.target && (event.target.value === 'Помогите определиться' || field.value === 'Помогите определиться')) field.checked = false;
      }
    }
  });
  form.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
    status.textContent = '';
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const group = form.querySelector('.product-field');
    const checks = [
      [form.elements.name, form.elements.name.value.trim().length >= 2],
      [form.elements.phone, /^7\d{10}$/.test(phone.value.replace(/\D/g, ''))],
      [form.elements.consent, form.elements.consent.checked],
      [group, !!group.querySelector('input:checked')]
    ];
    checks.forEach(([field, valid]) => valid ? field.removeAttribute('aria-invalid') : field.setAttribute('aria-invalid', 'true'));
    const [nameValid, phoneValid, consentValid] = checks.map(([, valid]) => valid);
    const firstInvalid = checks.find(([, valid]) => !valid);
    if (firstInvalid) {
      status.textContent = !nameValid ? 'Укажите ваше имя.' : !phoneValid ? 'Введите номер полностью: 10 цифр после +7.' : !consentValid ? 'Отметьте согласие на обработку персональных данных.' : 'Выберите направление или «Помогите определиться».';
      (firstInvalid[0] === group ? group.querySelector('input') : firstInvalid[0]).focus();
      return;
    }
    status.textContent = 'Это демонстрация: заявка никуда не отправляется.';
  });
})();
