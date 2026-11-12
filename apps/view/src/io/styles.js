/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/dashboard.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css */
/** The view's one stylesheet composer: view.css with every @pullboard-*-styles marker filled [N26,C7]. */
import { readFileSync } from 'node:fs';

/** Each marker's stylesheet, in view.css order; its marker keeps the cascade point where its rules stand. */
const VIEW_STYLESHEETS = new Map([
  ['items-row', './item/rows.css'],
  ['stage', './stage.css'],
  ['dashboard', './dashboard.css'],
  ['notch', './notch.css'],
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
  const css = readFileSync(new URL('./main.css', import.meta.url), 'utf8').replace(/\/\* @pullboard-([\w-]+)-styles \*\//gu, (marker, name) => {
    const file = VIEW_STYLESHEETS.get(name);
    if (!file || filled.has(name)) throw new Error(`view.css: ${marker} names no stylesheet, or names one twice`);
    filled.add(name);
    return readFileSync(new URL(file, import.meta.url), 'utf8').trimEnd();
  });
  const missing = [...VIEW_STYLESHEETS.keys()].filter(name => !filled.has(name));
  if (missing.length) throw new Error(`view.css has no marker for ${missing.map(name => `@pullboard-${name}-styles`).join(', ')}`);
  return css;
}
