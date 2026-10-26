import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../../site/scripts/main.js', import.meta.url), 'utf8');

test('an open mobile menu closes when the viewport reaches the desktop layout', async t => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  let width = 1250;
  const mediaQueries = [];
  window.matchMedia = query => {
    const minWidth = Number(query.match(/min-width:\s*(\d+)px/)?.[1]);
    const media = {
      matches: minWidth ? width >= minWidth : query === '(prefers-reduced-motion: reduce)',
      listeners: [],
      addEventListener(type, listener) { if (type === 'change') this.listeners.push(listener); },
    };
    mediaQueries.push({ minWidth, media });
    return media;
  };
  window.IntersectionObserver = class { observe() {} };
  window.ResizeObserver = class { observe() {} };
  Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() } });
  const resize = nextWidth => {
    width = nextWidth;
    window.innerWidth = width;
    for (const { minWidth, media } of mediaQueries) {
      if (!minWidth) continue;
      const matches = width >= minWidth;
      if (matches === media.matches) continue;
      media.matches = matches;
      for (const listener of media.listeners) listener({ matches });
    }
    window.dispatchEvent(new window.Event('resize'));
  };
  window.innerWidth = width;
  window.eval(code);
  // Let the fonts-ready callback settle while this document is still open.
  await Promise.resolve();
  const button = window.document.querySelector('.menu-toggle');
  const menu = window.document.querySelector('#mobile-menu');
  button.click();
  assert.equal(menu.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  resize(1270);
  assert.equal(menu.hidden, false, 'resizing inside the mobile layout keeps its open menu');
  resize(1300);
  assert.equal(menu.hidden, true, 'desktop navigation must not coexist with the open mobile overlay');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'Открыть меню');
  resize(1250);
  assert.equal(menu.hidden, true, 'returning to mobile must not resurrect the old open state');
  button.click();
  assert.equal(menu.hidden, false, 'the toggle still works after crossing both layouts');
});
