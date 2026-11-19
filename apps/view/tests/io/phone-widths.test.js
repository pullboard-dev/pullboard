/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css apps/view/src/io/cost.css */
/** @pullboard-world-pin reads the private Cost stylesheet beside the shared ones to prove the phone rules. */
/** At a 390 px phone the Items rows, the search box and the Cost models table stay inside the screen [U94,#6930]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../src/io/styles.js';

/** The shared stylesheet, then the private Cost stylesheet the view appends to it; comments dropped. */
const css = (composeViewStyles() + readFileSync(new URL('../../src/io/cost.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//gu, '');
/** Every declaration block written for exactly this selector, in file order, with the position of its rule. */
const blocks = (selector) => [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)]
  .filter((m) => m[1].split(',').some((part) => part.trim() === selector))
  .map((m) => ({ body: m[2], at: m.index }));
const last = (selector) => blocks(selector).at(-1);
/** Every @media block that sets display: none on a rule naming the selector. */
const hiddenInMedia = (selector) => [...css.matchAll(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/gu)]
  .filter((m) => [...m[1].matchAll(/([^{}]+)\{([^{}]*)\}/gu)].some((r) => r[1].split(',').some((p) => p.includes(selector)) && /display:\s*none/u.test(r[2])));

test('view.x-io-phone-widths.clause-1-at-390-px-an-items: clause 1: at 390 px an Items row title, code included, is one line cut with an ellipsis and never wraps into the next row [U94,#6930]', () => {
  const title = last('.row .t').body;
  assert.match(title, /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/u, 'the title line is cut with an ellipsis');
  const wrapping = last('code.inline.long');
  assert.match(wrapping.body, /white-space: break-spaces/u, 'a long code reference breaks anywhere elsewhere on the page');
  const inRow = last('.row .t code.inline.long');
  assert.ok(inRow, 'a long code reference inside a row title has its own rule');
  assert.match(inRow.body, /white-space: nowrap;/u, 'inside a row title the code stays on the title line');
  assert.match(inRow.body, /overflow-wrap: normal;/u, 'and no longer breaks anywhere');
  assert.ok(inRow.body && wrapping, 'the row rule names one more class than the page-wide one, so it wins wherever it sits');
  assert.match(last('#chain > li.row').body, /height: var\(--item-row-h\);[^}]*overflow: hidden;/u, 'every row is one fixed height and cuts what overflows');
  assert.match(last('.row.item-row > .row-copy').body, /min-width: 0;/u, 'the copy column may shrink below its text');
});

test('view.x-io-phone-widths.clause-2-at-390-px-the-search: clause 2: at 390 px the search box keeps its key hint and cuts its placeholder with an ellipsis, never the hint [U94,#6930]', () => {
  assert.deepEqual(hiddenInMedia('.top-find kbd').map((m) => m[0].slice(0, 30)), [], 'no media query hides the key hint');
  assert.deepEqual(hiddenInMedia('.pal-hint').map((m) => m[0].slice(0, 30)), [], 'no media query hides the key hint the palette adds');
  assert.match(last(':root[data-nav] .top-find input').body, /text-overflow: ellipsis;/u, 'a long placeholder ends in an ellipsis');
  assert.match(last(':root[data-nav] .top-find input').body, /padding: 0 var\(--space-9\) 0 var\(--space-3\);/u, 'the text stops where the hint starts');
  assert.match(last(':root[data-nav] .top-find kbd').body, /right: 8px;/u, 'the hint sits inside the box');
  assert.match(last(':root[data-nav] .top-find').body, /min-width: 0;/u, 'the box shrinks with the screen instead of pushing it');
});

test('view.x-io-phone-widths.clause-2-at-390-px-the-cost: clause 2: at 390 px the Cost models table scrolls inside its card and the page does not scroll sideways [U94,#6930]', () => {
  const wrap = blocks('.cost-model-table-wrap').map((b) => b.body).join(' ');
  assert.match(wrap, /overflow-x: auto;/u, 'the table scrolls inside its wrap');
  assert.match(wrap, /max-width: 100%;/u, 'the wrap is never wider than its card');
  assert.match(wrap, /min-width: 0;/u, 'the wrap may shrink below the table');
  assert.match(last('.cost-card').body, /min-width: 0;/u, 'the card may shrink below the wrap');
  assert.match(last('.cost-page > *').body, /min-width: 0;/u, 'every Cost section may shrink below its content');
  assert.match(last('.cost-model-table th').body, /white-space: nowrap;/u, 'the headings keep their words whole, so the wrap scrolls rather than the page');
});
