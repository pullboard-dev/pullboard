/** @pullboard-test-input apps/view/src/io/palette/client.js */
/** The page's search box, command palette and keyboard shortcuts, mounted by one call in the page script [U94 item 6, #6616]. */
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/**
 * The script text that mounts the palette in the hosted page. It runs inside the page's own script, so it reads
 * the page's tabs, board in memory, go() and theme directly; its rules come from the view stylesheet (a page may not add styles inline) and it fetches nothing.
 *
 * @returns {string} Script text to place after the page's other parts.
 */
export function paletteScript() {
  return `${CLIENT}
(() => {
  pbPalette({
    document,
    mac: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    box: $('q'),
    pages: () => [...document.querySelectorAll('#tabs [data-tab]')].map((b) => ({ id: b.dataset.tab, name: (b.querySelector('.tab-name b, .side-name') || b).textContent.trim(), count: (b.querySelector('[data-nav-fact]')?.textContent || '').trim() })).filter((p) => p.id !== 'settings'),
    hasTab: (id) => Boolean(document.querySelector('[data-tab="' + id + '"]')),
    items: () => (data?.project?.items || []).map((i) => ({ id: i.id, title: i.title, updatedAt: i.updatedAt, state: stateLabel(i) })),
    go: (target) => go(target),
    theme: () => flipTheme(),
    movePlace: () => { if (document.dispatchEvent(new CustomEvent('pullboard:move-navigation', { cancelable: true }))) $('side-toggle').click(); },
  });
})();
`;
}
