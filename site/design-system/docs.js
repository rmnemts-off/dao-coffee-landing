// Interactions of the design system page itself: copying colours, contrast
// figures, chapter navigation, the "no motion" preview and the demo form.
(() => {
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
    links.forEach((link, key) => link.toggleAttribute('aria-current', key === id));
    const active = links.get(id);
    const strip = active?.closest('ol');
    if (strip && getComputedStyle(strip).display === 'flex') {
      strip.scrollTo({ left: active.offsetLeft - 16, behavior: 'smooth' });
    }
  };
  const visible = new Set();
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target));
    const first = chapters.find(chapter => visible.has(chapter));
    if (first) mark(first.id);
  }, { rootMargin: '-35% 0px -55% 0px' });
  chapters.forEach(chapter => observer.observe(chapter));

  // Preview the page as it looks without motion.
  document.querySelector('#motion-off').addEventListener('change', event => {
    document.documentElement.toggleAttribute('data-motion-off', event.target.checked);
    document.querySelectorAll('[data-lit]').forEach(element => element.removeAttribute('data-lit'));
    say(event.target.checked ? 'Движение выключено' : 'Движение включено');
  });

  // Demo form: +7 mask, exclusive "help me choose", honest status.
  const form = document.querySelector('#ds-form');
  const phone = form.querySelector('[name=phone]');
  phone.addEventListener('input', () => {
    let digits = phone.value.replace(/\D/g, '');
    if (digits.startsWith('8') || digits.startsWith('7')) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    const part = (start, end) => digits.slice(start, end);
    let masked = '+7';
    if (digits.length) masked += ` (${part(0, 3)}`;
    if (digits.length >= 3) masked += `) ${part(3, 6)}`;
    if (digits.length >= 6) masked += `-${part(6, 8)}`;
    if (digits.length >= 8) masked += `-${part(8, 10)}`;
    phone.value = masked;
  });
  const undecided = form.querySelector('[value="Помогите определиться"]');
  form.querySelectorAll('[name=interests]').forEach(box => box.addEventListener('change', () => {
    if (!box.checked) return;
    if (box === undecided) form.querySelectorAll('[name=interests]').forEach(other => { if (other !== box) other.checked = false; });
    else undecided.checked = false;
  }));
  const setError = (input, message) => {
    const error = document.getElementById(input.getAttribute('aria-describedby'));
    input.toggleAttribute('aria-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    if (error) { error.textContent = message || ''; error.hidden = !message; }
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = form.querySelector('[name=name]');
    const status = form.querySelector('.form-status');
    const nameError = name.value.trim().length < 2 ? 'Введите имя' : '';
    const phoneError = phone.value.replace(/\D/g, '').length !== 11 ? 'Введите номер полностью' : '';
    const interests = form.querySelectorAll('[name=interests]:checked').length;
    const consent = form.querySelector('[name=consent]').checked;
    setError(name, nameError);
    setError(phone, phoneError);
    const interestField = form.querySelector('#ds-interests');
    if (interests) interestField.removeAttribute('aria-invalid');
    else interestField.setAttribute('aria-invalid', 'true');
    if (nameError || phoneError || !interests || !consent) {
      status.style.color = 'var(--error)';
      status.textContent = !consent && !nameError && !phoneError && interests ? 'Подтвердите согласие на обработку данных' : 'Проверьте отмеченные поля';
      (form.querySelector('[aria-invalid=true]') || form.querySelector('[name=consent]')).focus();
      return;
    }
    status.style.color = '';
    status.textContent = 'Это демонстрация: данные никуда не отправляются.';
  });
})();
