const menuButton = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('#mobile-menu');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const mobileLayout = matchMedia('(max-width: 960px), (hover: none), (pointer: coarse)');

function closeMenu(restoreFocus = false) {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Открыть меню');
  mobileMenu.hidden = true;
  if (restoreFocus) menuButton.focus();
}
menuButton.addEventListener('click', () => {
  const opening = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(opening));
  menuButton.setAttribute('aria-label', opening ? 'Закрыть меню' : 'Открыть меню');
  mobileMenu.hidden = !opening;
});
document.addEventListener('click', event => {
  if (!event.target.closest('.site-header')) closeMenu();
  if (event.target.closest('.mobile-menu a')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !mobileMenu.hidden) closeMenu(true);
});
matchMedia('(min-width: 1281px)').addEventListener('change', event => {
  if (event.matches) closeMenu();
});

// Direction-aware header. Native scrolling remains completely untouched.
const siteHeader = document.querySelector('.site-header');
let headerHidden = false;
let previousY = Math.max(0, window.scrollY);
let directionDistance = 0;
let lastScrollTime = 0;
let headerHeight = siteHeader.offsetHeight;
function showHeader(show) {
  if (headerHidden === !show) return;
  headerHidden = !show;
  siteHeader.toggleAttribute('data-hidden', headerHidden);
}
siteHeader.addEventListener('focusin', () => showHeader(true));
menuButton.addEventListener('click', () => {
  showHeader(true);
  if (!mobileMenu.hidden && window.gsap && !reduced.matches) {
    gsap.fromTo(mobileMenu, { y: -8, opacity: .65 }, { y: 0, opacity: 1, duration: .3, ease: 'power3.out', clearProps: 'transform,opacity', overwrite: true });
  }
});

// The direction in view is marked in both menus; the trail underline stays under it.
const navLinks = Array.from(document.querySelectorAll('.desktop-nav a, .mobile-menu a'));
const navSections = [...new Set(navLinks.map(link => link.hash))].map(hash => document.querySelector(hash)).filter(Boolean);
const sectionsInView = new Set();
const navObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => entry.isIntersecting ? sectionsInView.add(entry.target) : sectionsInView.delete(entry.target));
  const current = navSections.find(section => sectionsInView.has(section));
  navLinks.forEach(link => {
    if (current && link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}, { rootMargin: '-40% 0px -55% 0px' });
navSections.forEach(section => navObserver.observe(section));

// A shared light canvas; text stays the same dark green throughout the page.
const stageSections = Array.from(document.querySelectorAll('[data-stage-color]'));
const toRgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
let stageStops = [];
let lastStageColor = '';
let lastHeaderColor = '';
let stageTimer = 0;
let layoutWidth = document.documentElement.clientWidth;
let stableHeight = window.innerHeight;
const editingForm = () => document.activeElement?.matches('input,textarea,select');
const smoothStep = t => t * t * t * (t * (t * 6 - 15) + 10);
const mixColor = (from, to, t) => from.map((value, i) => +(value + (to[i] - value) * t).toFixed(3));
const colorCss = color => `rgb(${color.join(',')})`;
function measureStage() {
  if (editingForm() || document.querySelector('#project-dialog[open]')) return;
  const vh = mobileLayout.matches ? stableHeight : window.innerHeight;
  const nextHeaderHeight = Math.ceil(siteHeader.getBoundingClientRect().height);
  if (headerHeight !== nextHeaderHeight || !document.documentElement.style.getPropertyValue('--header-offset')) {
    headerHeight = nextHeaderHeight;
    document.documentElement.style.setProperty('--header-offset', `${headerHeight}px`);
  }
  let from = toRgb(stageSections[0].dataset.stageColor);
  let previousEnd = 0;
  stageStops = stageSections.slice(1).map((section, index) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    const start = Math.max(previousEnd, index === 0 ? 80 : 0, top - vh * .95);
    const stop = { start, end: Math.max(start + 1, top + vh * .05), from, to: toRgb(section.dataset.stageColor) };
    previousEnd = stop.end;
    from = stop.to;
    return stop;
  });
  if (mobileLayout.matches) {
    // One document-sized gradient: no full-page colour writes while swiping.
    // Sample the same easing used by the header, with stops wide enough to
    // survive rounding and mobile browser toolbar changes without seams.
    const stops = [`${colorCss(toRgb(stageSections[0].dataset.stageColor))} 0px`];
    for (const stop of stageStops) {
      for (let step = 0; step <= 8; step++) {
        const t = step / 8;
        stops.push(`${colorCss(mixColor(stop.from, stop.to, smoothStep(t)))} ${(stop.start + (stop.end - stop.start) * t).toFixed(1)}px`);
      }
    }
    document.body.style.backgroundImage = `linear-gradient(180deg,${stops.join(',')})`;
  } else document.body.style.backgroundImage = '';
  document.body.classList.toggle('static-stage', mobileLayout.matches);
  paintStage(Math.max(0, window.scrollY));
}
function stageColorAt(y) {
  let color = toRgb(stageSections[0].dataset.stageColor);
  for (const stop of stageStops) {
    if (y >= stop.end) { color = stop.to; continue; }
    if (y <= stop.start) break;
    const t = smoothStep((y - stop.start) / (stop.end - stop.start));
    color = mixColor(stop.from, stop.to, t);
    break;
  }
  return colorCss(color);
}
function paintStage(y) {
  const css = stageColorAt(y);
  if (!mobileLayout.matches && css !== lastStageColor) {
    document.body.style.backgroundColor = css;
    lastStageColor = css;
  }
  const headerColor = mobileLayout.matches ? stageColorAt(y + headerHeight / 2) : css;
  if (headerColor !== lastHeaderColor) {
    siteHeader.style.setProperty('--header-surface', headerColor);
    lastHeaderColor = headerColor;
  }
}
function queueStageMeasure() {
  clearTimeout(stageTimer);
  // A resizing accordion must not measure every section on every frame.
  stageTimer = setTimeout(measureStage, 140);
}
let scrollFrame = 0;
function onPageScroll() {
  scrollFrame = 0;
  const y = Math.max(0, Math.min(window.scrollY, document.documentElement.scrollHeight - window.innerHeight));
  if (document.querySelector('#project-dialog[open]') || (mobileLayout.matches && editingForm())) {
    previousY = y;
    directionDistance = 0;
    return;
  }
  const delta = y - previousY;
  const now = performance.now();
  if (now - lastScrollTime > 180) directionDistance = 0;
  if (delta !== 0) {
    directionDistance = Math.sign(delta) === Math.sign(directionDistance) ? directionDistance + delta : delta;
    lastScrollTime = now;
  }
  siteHeader.toggleAttribute('data-scrolled', y > 24);
  if (y < 40 || !mobileMenu.hidden || siteHeader.querySelector(':focus-visible')) showHeader(true);
  else if (directionDistance > (mobileLayout.matches ? 48 : 32) && y > headerHeight + 40) showHeader(false);
  else if (directionDistance < (mobileLayout.matches ? -24 : -14)) showHeader(true);
  previousY = y;
  paintStage(y);
}
window.addEventListener('scroll', () => {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(onPageScroll);
}, { passive: true });
// Static section backgrounds remain the fallback when JavaScript is unavailable.
measureStage();
document.body.classList.add('scroll-stage');
const stageResize = new ResizeObserver(queueStageMeasure);
stageResize.observe(document.querySelector('main'));
stageResize.observe(siteHeader);
window.addEventListener('resize', () => {
  const width = document.documentElement.clientWidth;
  if (mobileLayout.matches && width === layoutWidth) return;
  layoutWidth = width;
  stableHeight = window.innerHeight;
  queueStageMeasure();
}, { passive: true });
mobileLayout.addEventListener('change', () => {
  stableHeight = window.innerHeight;
  queueStageMeasure();
});
document.fonts.ready.then(queueStageMeasure);
document.addEventListener('focusout', event => {
  if (event.target.matches('input,textarea,select')) queueStageMeasure();
});
document.querySelector('#project-dialog').addEventListener('close', queueStageMeasure);

// One material at a time. CSS owns height; closed links leave the keyboard order.
const materialItems = Array.from(document.querySelectorAll('.material-item.t-acc'));
function setMaterialOpen(item, open) {
  const head = item.querySelector('.t-acc-head');
  const panel = item.querySelector('.t-acc-panel');
  item.setAttribute('data-open', String(open));
  head.setAttribute('aria-expanded', String(open));
  panel.inert = !open;
}
materialItems.forEach(item => {
  setMaterialOpen(item, false);
  item.querySelector('.t-acc-head').addEventListener('click', () => {
    const opening = item.getAttribute('data-open') !== 'true';
    materialItems.forEach(other => setMaterialOpen(other, other === item && opening));
  });
});

// A short press remains perceptible after a quick click, as in Total Stream.
const pressEffects = new Map();
let activePress;
function startPress(element) {
  if (reduced.matches || element.matches(':disabled')) return;
  finishPress(activePress, true);
  const previous = pressEffects.get(element);
  clearTimeout(previous?.timer);
  const current = getComputedStyle(element).transform;
  previous?.animation?.cancel();
  const state = { start: performance.now(), held: true };
  element.setAttribute('data-pressed', '');
  state.animation = element.animate([{ transform: current === 'none' ? 'scale(1)' : current }, { transform: element.matches('.cta,.header-cta,.menu-toggle,.brand') ? 'scale(.97)' : 'scale(.985)' }], { duration: 150, easing: 'cubic-bezier(.2,.6,.2,1)', fill: 'forwards' });
  pressEffects.set(element, state);
  activePress = element;
}
function finishPress(element, immediate = false) {
  const state = pressEffects.get(element);
  if (!state || !state.held) return;
  state.held = false;
  state.timer = setTimeout(() => {
    const current = getComputedStyle(element).transform;
    state.animation?.cancel();
    element.removeAttribute('data-pressed');
    const animation = element.animate([{ transform: current === 'none' ? 'scale(1)' : current }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    state.animation = animation;
    animation.finished.then(() => {
      if (pressEffects.get(element) === state) pressEffects.delete(element);
    }).catch(() => {});
  }, immediate ? 0 : Math.max(0, 170 - (performance.now() - state.start)));
  if (activePress === element) activePress = undefined;
}
// The header logo and contacts share the same subtle press, as requested.
document.querySelectorAll('.cta,.product-cta,.desktop-nav a,.mobile-menu a,.menu-toggle,.brand,.contact-channel').forEach(element => {
  element.addEventListener('pointerdown', event => {
    if (event.button === 0 && event.isPrimary) startPress(element);
  });
  element.addEventListener('keydown', event => {
    if (!event.repeat && (event.key === 'Enter' || (event.key === ' ' && element instanceof HTMLButtonElement))) startPress(element);
  });
  element.addEventListener('keyup', event => {
    if (event.key === 'Enter' || event.key === ' ') finishPress(element);
  });
});
window.addEventListener('pointerup', () => finishPress(activePress));
window.addEventListener('pointercancel', () => finishPress(activePress));
window.addEventListener('blur', () => finishPress(activePress));
reduced.addEventListener('change', () => {
  for (const [element, state] of pressEffects) {
    clearTimeout(state.timer); state.animation?.cancel(); element.removeAttribute('data-pressed');
  }
  pressEffects.clear(); activePress = undefined;
});

// Native scroll; one gentle reveal on entry, no pinning, scrub or scroll engine.
if (window.gsap) {
  const media = gsap.matchMedia();
  media.add('(min-width: 961px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
    gsap.fromTo('.hero-content > *', { y: 18, opacity: .8 }, { y: 0, opacity: 1, duration: .9, stagger: .12, ease: 'power3.out', clearProps: 'transform,opacity' });
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const isProduct = entry.target.matches('.product-visual');
        const isHeading = entry.target.matches('.section-heading');
        gsap.fromTo(entry.target,
          { y: isProduct ? 32 : isHeading ? 20 : 14, opacity: .88, scale: isProduct ? .98 : 1 },
          { y: 0, opacity: 1, scale: 1, duration: isProduct ? 1.05 : .75, ease: 'power3.out', clearProps: 'transform,opacity' }
        );
      }
    }, { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(element => observer.observe(element));
    return () => {
      observer.disconnect();
      const elements = document.querySelectorAll('.reveal,.hero-content > *');
      gsap.killTweensOf(elements);
      gsap.set(elements, { clearProps: 'transform,opacity' });
    };
  });
  // Product hover is a CSS zoom towards the viewer (design.css), not a pointer drift.
}
