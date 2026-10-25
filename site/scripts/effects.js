// Brand micro-interactions shared by the landing and the design system page.
// Each effect is opt-in through markup and writes only CSS variables or classes
// (the scratch-off cover draws on its own canvas). Hover effects stay off on
// touch screens and with reduced motion. No scroll listeners.
(() => {
  const finePointer = matchMedia('(min-width: 961px) and (hover: hover) and (pointer: fine)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  // The design system page can switch effects off to preview the static state.
  const canHover = () => finePointer.matches && !reduced.matches && !root.hasAttribute('data-motion-off');

  // Pointer position as --mx/--my, one write per frame: the spotlight inside
  // buttons and model cards, and the pattern lit around the cursor.
  const hoverTargets = Array.from(document.querySelectorAll('[data-spotlight], .topo[data-topo-lit]'));
  let hoverCleanup = [];
  function syncHover() {
    hoverCleanup.forEach(cleanup => cleanup());
    hoverCleanup = [];
    root.classList.toggle('js-motion', finePointer.matches && !reduced.matches);
    if (!finePointer.matches || reduced.matches) return;
    hoverTargets.forEach(element => {
      let frame = 0;
      let pointer;
      const paint = () => {
        frame = 0;
        const box = element.getBoundingClientRect();
        element.style.setProperty('--mx', `${pointer.clientX - box.left}px`);
        element.style.setProperty('--my', `${pointer.clientY - box.top}px`);
        element.setAttribute('data-lit', '');
      };
      const move = event => {
        if ((event.pointerType !== 'mouse' && event.pointerType !== 'pen') || !canHover()) return;
        pointer = event;
        frame ||= requestAnimationFrame(paint);
      };
      const leave = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        element.removeAttribute('data-lit');
        element.style.removeProperty('--mx');
        element.style.removeProperty('--my');
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerleave', leave);
      hoverCleanup.push(() => {
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerleave', leave);
        leave();
      });
    });
  }
  syncHover();
  finePointer.addEventListener('change', syncHover);
  reduced.addEventListener('change', syncHover);

  // Runs `onSeen` once per element when it scrolls into view; at once without
  // an observer or with reduced motion.
  const whenSeen = (elements, onSeen, threshold) => {
    if (!('IntersectionObserver' in window) || !canHover()) return elements.forEach(onSeen);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        onSeen(entry.target);
      }
    }, { threshold });
    elements.forEach(element => observer.observe(element));
  };

  // Trails draw themselves once. A trail starts fully clipped, which observers
  // report as invisible, so the element it belongs to is watched instead.
  const owners = new Map();
  document.querySelectorAll('[data-trail]').forEach(trail => {
    const owner = trail.parentElement;
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(trail);
  });
  whenSeen(Array.from(owners.keys()), owner => owners.get(owner).forEach(trail => trail.classList.add('is-drawn')), .15);

  // Lists rise into place line by line; the delays live in CSS (--i).
  whenSeen(Array.from(document.querySelectorAll('[data-cascade]')), list => list.classList.add('is-in'), .3);

  // Scratch-off cover: a brand-green layer with the contour pattern that the
  // visitor rubs away (mouse held down, pen or finger). Without JS, or once
  // half of it is gone, the photo underneath is simply visible. A keyboard
  // user gets a button that removes the layer.
  const scratchFigures = canHover() ? Array.from(document.querySelectorAll('[data-scratch]')) : [];
  if (!scratchFigures.length) return;
  const contours = new Image();
  contours.src = '/assets/pattern/topo-portrait.svg';
  const coarse = matchMedia('(pointer: coarse)');
  scratchFigures.forEach(figure => {
    const canvas = document.createElement('canvas');
    canvas.className = 'scratch-cover';
    canvas.setAttribute('aria-hidden', 'true');
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'scratch-reveal';
    reveal.textContent = 'Показать фото';
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let touched = false;
    let done = false;
    let last;
    let moves = 0;

    const paint = () => {
      const box = figure.getBoundingClientRect();
      if (!box.width || touched) return;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
      const { width, height } = canvas;
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#1d644f';
      context.fillRect(0, 0, width, height);
      if (contours.complete && contours.naturalWidth) {
        // Cover-fit the contours, like background-size: cover.
        const scale = Math.max(width / contours.naturalWidth, height / contours.naturalHeight);
        const w = contours.naturalWidth * scale;
        const h = contours.naturalHeight * scale;
        context.globalAlpha = .2;
        context.drawImage(contours, (width - w) / 2, (height - h) / 2, w, h);
        context.globalAlpha = 1;
      }
      const size = width * .082;
      context.fillStyle = '#f4eae5';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `700 ${size * 1.25}px "Ysabeau Office", sans-serif`;
      context.fillText('Сотрите слой', width / 2, height / 2 - size * .7);
      context.font = `500 ${size}px "Ysabeau Office", sans-serif`;
      context.globalAlpha = .82;
      context.fillText(coarse.matches ? 'проведите пальцем' : 'зажмите и ведите', width / 2, height / 2 + size * .8);
      context.globalAlpha = 1;
    };

    const finish = () => {
      if (done) return;
      done = true;
      canvas.classList.add('is-done');
      // Keep keyboard focus on the photo instead of dropping it to the page.
      if (document.activeElement === reveal) {
        figure.tabIndex = -1;
        figure.focus({ preventScroll: true });
      }
      reveal.remove();
    };
    // Share of the layer already wiped, sampled on a sparse grid.
    const cleared = () => {
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const step = 4 * 7;
      let clear = 0;
      let total = 0;
      for (let index = 3; index < data.length; index += step) {
        total++;
        if (data[index] < 128) clear++;
      }
      return clear / total;
    };
    const scratch = event => {
      const box = canvas.getBoundingClientRect();
      const ratio = canvas.width / box.width;
      const point = { x: (event.clientX - box.left) * ratio, y: (event.clientY - box.top) * ratio };
      touched = true;
      context.globalCompositeOperation = 'destination-out';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = canvas.width * .16;
      context.beginPath();
      context.moveTo((last || point).x, (last || point).y);
      context.lineTo(point.x + .01, point.y);
      context.stroke();
      last = point;
      if (++moves % 10 === 0 && cleared() > .5) finish();
    };

    canvas.addEventListener('pointerdown', event => {
      if (done || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      last = undefined;
      scratch(event);
    });
    canvas.addEventListener('pointermove', event => {
      if (done || !canvas.hasPointerCapture(event.pointerId)) return;
      scratch(event);
    });
    const release = event => {
      last = undefined;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!done && touched && cleared() > .5) finish();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    reveal.addEventListener('click', finish);

    figure.append(canvas, reveal);
    paint();
    // Repaint for crisp edges at a new size until the first stroke; after
    // that the canvas just stretches with the 4:5 frame.
    new ResizeObserver(paint).observe(figure);
    contours.addEventListener('load', paint, { once: true });
    document.fonts?.load('700 20px "Ysabeau Office"').then(paint, () => {});
  });
})();
