const menuButton = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('#mobile-menu');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

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
matchMedia('(min-width: 1201px)').addEventListener('change', event => {
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
  if (window.gsap) {
    gsap.to(siteHeader, {
      yPercent: show ? 0 : -105,
      duration: reduced.matches ? 0 : (show ? .55 : .42),
      ease: show ? 'power3.out' : 'power2.inOut',
      overwrite: true
    });
  } else siteHeader.style.transform = show ? '' : 'translateY(-110%)';
}
siteHeader.addEventListener('focusin', () => showHeader(true));
menuButton.addEventListener('click', () => {
  showHeader(true);
  if (!mobileMenu.hidden && window.gsap && !reduced.matches) {
    gsap.fromTo(mobileMenu, { y: -8, opacity: .65 }, { y: 0, opacity: 1, duration: .3, ease: 'power3.out', clearProps: 'transform,opacity', overwrite: true });
  }
});

// A shared light canvas; text stays the same dark green throughout the page.
const stageSections = Array.from(document.querySelectorAll('[data-stage-color]'));
const toRgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
let stageStops = [];
let lastStageColor = '';
function measureStage() {
  const vh = window.innerHeight;
  headerHeight = siteHeader.offsetHeight;
  let from = toRgb(stageSections[0].dataset.stageColor);
  stageStops = stageSections.slice(1).map((section, index) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    const stop = { start: Math.max(index === 0 ? 80 : 0, top - vh * .95), end: top + vh * .05, from, to: toRgb(section.dataset.stageColor) };
    from = stop.to;
    return stop;
  });
  paintStage(Math.max(0, window.scrollY));
}
function paintStage(y) {
  let color = toRgb(stageSections[0].dataset.stageColor);
  for (const stop of stageStops) {
    if (y >= stop.end) { color = stop.to; continue; }
    if (y <= stop.start) break;
    let t = (y - stop.start) / (stop.end - stop.start);
    // Zero velocity and acceleration at each end; fractional channels avoid stepping.
    t = t * t * t * (t * (t * 6 - 15) + 10);
    color = stop.from.map((value, i) => +(value + (stop.to[i] - value) * t).toFixed(3));
    break;
  }
  const css = `rgb(${color.join(',')})`;
  if (css !== lastStageColor) { document.body.style.backgroundColor = css; lastStageColor = css; }
}
let scrollFrame = 0;
function onPageScroll() {
  scrollFrame = 0;
  const y = Math.max(0, Math.min(window.scrollY, document.documentElement.scrollHeight - window.innerHeight));
  const delta = y - previousY;
  const now = performance.now();
  if (now - lastScrollTime > 180) directionDistance = 0;
  if (delta !== 0) {
    directionDistance = Math.sign(delta) === Math.sign(directionDistance) ? directionDistance + delta : delta;
    lastScrollTime = now;
  }
  siteHeader.toggleAttribute('data-scrolled', y > 24);
  if (y < 40 || !mobileMenu.hidden || siteHeader.querySelector(':focus-visible')) showHeader(true);
  else if (directionDistance > 32 && y > headerHeight + 40) showHeader(false);
  else if (directionDistance < -14) showHeader(true);
  previousY = y;
  paintStage(y);
}
window.addEventListener('scroll', () => {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(onPageScroll);
}, { passive: true });
// Static section backgrounds remain the fallback when JavaScript is unavailable.
measureStage();
document.body.classList.add('scroll-stage');
const stageResize = new ResizeObserver(measureStage);
stageResize.observe(document.querySelector('main'));
window.addEventListener('resize', measureStage, { passive: true });
document.fonts.ready.then(measureStage);
reduced.addEventListener('change', () => {
  if (window.gsap) { gsap.killTweensOf(siteHeader); gsap.set(siteHeader, { yPercent: headerHidden ? -105 : 0 }); }
});

// A short press remains perceptible after a quick click, as in Total Stream.
const pressEffects = new Map();
let activePress;
function startPress(element) {
  if (reduced.matches || element.matches(':disabled')) return;
  finishPress(activePress, true);
  const previous = pressEffects.get(element);
  clearTimeout(previous?.timer);
  const current = getComputedStyle(element).scale;
  previous?.animation?.cancel();
  const state = { start: performance.now(), held: true };
  element.setAttribute('data-pressed', '');
  state.animation = element.animate([{ scale: current === 'none' ? '1' : current }, { scale: element.matches('.cta,.header-cta,.menu-toggle') ? '.97' : '.985' }], { duration: 150, easing: 'cubic-bezier(.2,.6,.2,1)', fill: 'forwards' });
  pressEffects.set(element, state);
  activePress = element;
}
function finishPress(element, immediate = false) {
  const state = pressEffects.get(element);
  if (!state || !state.held) return;
  state.held = false;
  state.timer = setTimeout(() => {
    const current = getComputedStyle(element).scale;
    state.animation?.cancel();
    element.removeAttribute('data-pressed');
    const animation = element.animate([{ scale: current === 'none' ? '1' : current }, { scale: '1' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    state.animation = animation;
    animation.finished.then(() => {
      if (pressEffects.get(element) === state) pressEffects.delete(element);
    }).catch(() => {});
  }, immediate ? 0 : Math.max(0, 170 - (performance.now() - state.start)));
  if (activePress === element) activePress = undefined;
}
document.querySelectorAll('.cta,.product-cta,.dialog-close,.header-cta,.desktop-nav a,.mobile-menu a,.quiet-link,.scroll-cue,.back-top,.brand,.header-phone,.contact-links a,.menu-toggle').forEach(element => {
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
  media.add('(prefers-reduced-motion: no-preference)', () => {
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

  // Each product has its own stable hover area, including the two Italian products.
  media.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
    const cleanups = [];
    const resets = [];
    const images = [];
    const motionAreas = Array.from(document.querySelectorAll('.product-visual')).flatMap(figure => {
      const pieces = Array.from(figure.querySelectorAll('.italian-piece'));
      return pieces.length ? pieces : [figure];
    });
    motionAreas.forEach(area => {
      const targets = Array.from(area.querySelectorAll('img'));
      if (!targets.length) return;
      images.push(...targets);
      const movers = targets.map(image => ({
        x: gsap.quickTo(image, 'x', { duration: .55, ease: 'power3.out' }),
        y: gsap.quickTo(image, 'y', { duration: .55, ease: 'power3.out' })
      }));
      let bounds;
      let active = false;
      const move = event => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        // Read once on entry; scrolling/resizing invalidates this rectangle below.
        bounds ||= area.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        active = true;
        const x = gsap.utils.clamp(-1, 1, (event.clientX - bounds.left) / bounds.width * 2 - 1) * 6;
        const y = gsap.utils.clamp(-1, 1, (event.clientY - bounds.top) / bounds.height * 2 - 1) * 5;
        movers.forEach(mover => { mover.x(x); mover.y(y); });
      };
      const reset = () => {
        bounds = undefined;
        if (!active) return;
        active = false;
        movers.forEach(mover => { mover.x(0); mover.y(0); });
      };
      area.addEventListener('pointerenter', move);
      area.addEventListener('pointermove', move);
      area.addEventListener('pointerleave', reset);
      area.addEventListener('pointercancel', reset);
      resets.push(reset);
      cleanups.push(() => {
        area.removeEventListener('pointerenter', move);
        area.removeEventListener('pointermove', move);
        area.removeEventListener('pointerleave', reset);
        area.removeEventListener('pointercancel', reset);
      });
    });
    const resetAll = () => resets.forEach(reset => reset());
    window.addEventListener('scroll', resetAll, { passive: true });
    window.addEventListener('resize', resetAll, { passive: true });
    window.addEventListener('blur', resetAll);
    return () => {
      cleanups.forEach(cleanup => cleanup());
      window.removeEventListener('scroll', resetAll);
      window.removeEventListener('resize', resetAll);
      window.removeEventListener('blur', resetAll);
      gsap.killTweensOf(images);
      gsap.set(images, { clearProps: 'transform' });
    };
  });
}
