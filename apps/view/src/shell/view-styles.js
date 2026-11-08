/** @pullboard-test-input apps/view/src/shell/view.css apps/view/src/shell/view/dashboard.css apps/view/src/shell/view/item-rows.css apps/view/src/shell/view/stage.css */
/** The view's one stylesheet composer: view.css with every @pullboard-*-styles marker filled [N26,C7]. */
import { readFileSync } from 'node:fs';

/** Each marker's stylesheet, in view.css order; its marker keeps the cascade point where its rules stand. */
const VIEW_STYLESHEETS = new Map([
  ['items-row', './view/item-rows.css'],
  ['stage', './view/stage.css'],
  ['dashboard', './view/dashboard.css'],
]);

/**
 * view.css with each marker replaced by its stylesheet, its trailing whitespace trimmed, so the
 * rules stand where they would if written in view.css. A marker naming no stylesheet, or naming one
 * twice, and a stylesheet whose marker is missing all throw rather than serve a page without rules.
 *
 * @returns {string}
 */
export function composeViewStyles() {
  const filled = new Set();
  const css = readFileSync(new URL('./view.css', import.meta.url), 'utf8').replace(/\/\* @pullboard-([\w-]+)-styles \*\//gu, (marker, name) => {
    const file = VIEW_STYLESHEETS.get(name);
    if (!file || filled.has(name)) throw new Error(`view.css: ${marker} names no stylesheet, or names one twice`);
    filled.add(name);
    return readFileSync(new URL(file, import.meta.url), 'utf8').trimEnd();
  });
  const missing = [...VIEW_STYLESHEETS.keys()].filter(name => !filled.has(name));
  if (missing.length) throw new Error(`view.css has no marker for ${missing.map(name => `@pullboard-${name}-styles`).join(', ')}`);
  return css;
}
