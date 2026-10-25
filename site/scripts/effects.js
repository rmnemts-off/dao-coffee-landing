// Brand micro-interactions shared by the landing and the design system page.
// Each effect is opt-in through markup, writes only CSS variables or classes,
// and stays off on touch screens and with reduced motion. No scroll listeners.
(() => {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  // The design system page can switch effects off to preview the static state.
  const canHover = () => finePointer.matches && !reduced.matches && !root.hasAttribute('data-motion-off');

  root.classList.toggle('js-motion', !reduced.matches);
  reduced.addEventListener('change', () => root.classList.toggle('js-motion', !reduced.matches));

  // Pointer position as --mx/--my, one write per frame: the spotlight inside
  // buttons and model cards, and the pattern lit around the cursor.
  document.querySelectorAll('[data-spotlight], .topo[data-topo-lit]').forEach(element => {
    let frame = 0;
    let pointer;
    const paint = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      element.style.setProperty('--mx', `${pointer.clientX - box.left}px`);
      element.style.setProperty('--my', `${pointer.clientY - box.top}px`);
      element.setAttribute('data-lit', '');
    };
    element.addEventListener('pointermove', event => {
      if ((event.pointerType !== 'mouse' && event.pointerType !== 'pen') || !canHover()) return;
      pointer = event;
      frame ||= requestAnimationFrame(paint);
    });
    element.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      frame = 0;
      element.removeAttribute('data-lit');
    });
  });

  // Trails draw themselves once. A trail starts fully clipped, which observers
  // report as invisible, so the element it belongs to is watched instead.
  const trails = document.querySelectorAll('[data-trail]');
  const draw = trail => trail.classList.add('is-drawn');
  if (!('IntersectionObserver' in window) || reduced.matches) trails.forEach(draw);
  else {
    const owners = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        owners.get(entry.target).forEach(draw);
      }
    }, { threshold: .15 });
    trails.forEach(trail => {
      const owner = trail.parentElement;
      if (!owners.has(owner)) {
        owners.set(owner, []);
        observer.observe(owner);
      }
      owners.get(owner).push(trail);
    });
  }
})();
