// DAO COFFEE GROUP micro-interactions. Every effect is opt-in through a data
// attribute, uses only transform/opacity/CSS variables, and stays off on touch
// screens and with reduced motion. No scroll listeners: entry uses an observer.
(() => {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const canHover = () => finePointer.matches && !reduced.matches && !root.hasAttribute('data-motion-off');

  root.classList.toggle('js-motion', !reduced.matches);
  reduced.addEventListener('change', () => root.classList.toggle('js-motion', !reduced.matches));

  // Pointer position inside an element as --mx/--my, one write per frame.
  function trackPointer(element, onMove, onLeave) {
    let frame = 0;
    let event;
    const update = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return;
      onMove(event.clientX - box.left, event.clientY - box.top, box);
    };
    element.addEventListener('pointermove', next => {
      if (next.pointerType !== 'mouse' && next.pointerType !== 'pen') return;
      if (!canHover()) return;
      event = next;
      frame ||= requestAnimationFrame(update);
    });
    element.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      frame = 0;
      onLeave();
    });
  }

  // Spotlight on buttons and cards; flashlight on the contour pattern.
  document.querySelectorAll('[data-spotlight], .topo[data-topo-lit]').forEach(element => {
    trackPointer(element, (x, y) => {
      element.style.setProperty('--mx', `${x}px`);
      element.style.setProperty('--my', `${y}px`);
      element.toggleAttribute('data-lit', true);
    }, () => element.removeAttribute('data-lit'));
  });

  // Large product pictures drift after the cursor by at most 6 x 5 px.
  document.querySelectorAll('[data-follow]').forEach(area => {
    const targets = area.querySelectorAll('img');
    trackPointer(area, (x, y, box) => {
      const fx = Math.max(-1, Math.min(1, x / box.width * 2 - 1)) * 6;
      const fy = Math.max(-1, Math.min(1, y / box.height * 2 - 1)) * 5;
      targets.forEach(image => {
        image.style.setProperty('--fx', `${fx.toFixed(2)}px`);
        image.style.setProperty('--fy', `${fy.toFixed(2)}px`);
      });
    }, () => targets.forEach(image => {
      image.style.removeProperty('--fx');
      image.style.removeProperty('--fy');
    }));
  });

  // One gentle entry per element: blocks rise, trails draw themselves.
  // A trail starts fully clipped, which observers treat as invisible, so its
  // parent is watched instead.
  const entering = document.querySelectorAll('[data-reveal], [data-trail]');
  const settle = element => element.classList.add(element.hasAttribute('data-trail') ? 'is-drawn' : 'is-in');
  if (!('IntersectionObserver' in window) || reduced.matches) entering.forEach(settle);
  else {
    const watched = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        settle(watched.get(entry.target));
      }
    }, { threshold: .15 });
    entering.forEach(element => {
      const target = element.hasAttribute('data-trail') ? element.parentElement : element;
      watched.set(target, element);
      observer.observe(target);
    });
  }
})();
