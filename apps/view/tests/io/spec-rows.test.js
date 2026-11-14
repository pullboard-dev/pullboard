/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/page/render.js apps/view/src/io/page/actions.js */
/** @pullboard-world-pin reads the shipped stylesheet and page renderer source to prove the Spec and Doctrine row and header rules. */
/** Spec and Doctrine group headers carry no Approve all, and their rows fit the card at every width [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const file = name => readFileSync(new URL('../../src/io/' + name, import.meta.url), 'utf8');

test('clause 1: Spec and Doctrine group headers carry no Approve all and use the sheet level-2 header [N26]', () => {
  const render = file('page/render.js'), actions = file('page/actions.js'), css = file('main.css');
  assert.doesNotMatch(render + actions + css, /data-section-approve|spec-section-approve|dataset\.sectionApprove/u, 'no section approval control is drawn, handled or styled');
  assert.match(render, /<div class="spec-section-head doctrine-section-head"><h3 class="hd2">/u, 'the group header is the level-2 header');
  assert.doesNotMatch(render, /<h4>/u, 'the third header style is gone');
  assert.doesNotMatch(css, /#spec-list h4/u, 'and so is its rule');
});

test('clause 2: rows end refs and test paths in an ellipsis inside the row, and the phone tabs stay inside the card [N26]', () => {
  const css = file('main.css');
  assert.match(css, /:is\(#spec-list, #doctrine-list\) \.spec-record \{ min-width: 0; overflow: hidden; \}/u, 'a row clips to its card');
  assert.match(css, /\.spec-record \.meta > \* \{[^}]*min-width: 0;[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/u, 'refs, reasons and test paths shrink with an ellipsis');
  assert.match(css, /\.spec-record a\.ref \{[^}]*max-width: 100%;[^}]*text-overflow: ellipsis/u, 'a ref in a row never outgrows it');
  const phone = css.slice(css.indexOf('@media (max-width: 700px) {\n  #spec-chips .seg'));
  assert.match(phone, /#spec-chips \.seg, #doctrine-chips \.seg \{ display: flex; width: 100%; overflow: hidden; \}/u, 'the tabs fill the card and do not scroll past it');
  assert.match(phone, /\.seg button \{ flex: 0 1 auto; min-width: 0;/u, 'each tab keeps its natural width and shrinks only when the row is full');
});
