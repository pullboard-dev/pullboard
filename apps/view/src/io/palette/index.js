/** @pullboard-test-input apps/view/src/io/palette/client.js apps/view/src/io/palette/palette.css */
/** The page's search box, command palette and keyboard shortcuts, mounted by one call in the page script [U94 item 6, #6616]. */
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('./palette.css', import.meta.url), 'utf8');

/**
 * The script text that mounts the palette in the hosted page. It runs inside the page's own script, so it reads
 * the page's tabs, board in memory, go() and theme directly; it adds its stylesheet and fetches nothing.
 *
 * @returns {string} Script text to place after the page's other parts.
 */
export function paletteScript() {
  const css = JSON.stringify(STYLES).replace(/</gu, '\\u003c');
  return `${CLIENT}
(() => {
  const style = document.createElement('style');
  style.textContent = ${css};
  document.head.appendChild(style);
  pbPalette({
    document,
    mac: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    box: $('q'),
    pages: () => [...document.querySelectorAll('#tabs [data-tab]')].map((b) => ({ id: b.dataset.tab, name: b.textContent.trim() })).filter((p) => p.id !== 'settings'),
    hasTab: (id) => Boolean(document.querySelector('[data-tab="' + id + '"]')),
    items: () => (data?.project?.items || []).map((i) => ({ id: i.id, title: i.title, updatedAt: i.updatedAt, state: stateLabel(i) })),
    go: (target) => go(target),
    theme: () => flipTheme(),
    movePlace: () => { if (document.dispatchEvent(new CustomEvent('pullboard:move-navigation', { cancelable: true }))) $('side-toggle').click(); },
  });
})();
`;
}
