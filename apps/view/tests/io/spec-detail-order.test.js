/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/doctrine.css apps/view/src/io/page/render.js */
/** @pullboard-world-pin reads the shipped stylesheets and page renderer source to prove the Spec and Doctrine detail order, Cited by cut and type size. */
/** Spec and Doctrine detail puts the ruling buttons right under the row, above Proved by and Cited by [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const file = name => readFileSync(new URL('../../src/io/' + name, import.meta.url), 'utf8');
const paint = (render, id) => render.slice(render.indexOf("store.paint($('" + id + "')"));

test('view.x-io-spec-detail-order.clause-1-the-buttons-come-right-after: clause 1: the buttons come right after the row text and chips, before Proved by and Cited by [N26]', () => {
  const render = file('page/render.js');
  const spec = paint(render, 'spec-detail').split('continue;')[0];
  assert.ok(spec.indexOf('spec-detail-actions') > spec.indexOf('class="meta"'), 'Spec: buttons follow the chips');
  assert.ok(spec.indexOf('spec-detail-actions') < spec.indexOf('Proved by'), 'Spec: buttons sit above Proved by');
  assert.ok(spec.indexOf('spec-detail-actions') < spec.indexOf('Cited by'), 'Spec: buttons sit above Cited by');
  const doctrine = paint(render, 'doctrine-detail').split('continue;')[0];
  assert.ok(doctrine.indexOf('spec-detail-actions') > doctrine.indexOf('class="meta"'), 'Doctrine: buttons follow the chips');
  assert.ok(doctrine.indexOf('rowDecisionActions') < doctrine.indexOf('+ facts'), 'Doctrine: buttons sit above the proof and citation facts');
});

test('view.x-io-spec-detail-order.clause-2-cited-by-shows-five-items: clause 2: Cited by shows five items, then one line with the rest of the count that expands in place [N26]', () => {
  const render = file('page/render.js');
  assert.match(render, /list\.slice\(0, 5\)\.map\(link\)/u, 'the first five items are drawn');
  assert.match(render, /<details class="spec-more"><summary>' \+ rest\.length \+ ' more<\/summary>' \+ rest\.map\(link\)/u, 'one summary line holds the rest and opens in place');
  assert.equal(render.match(/citedBy\(citing/gu).length, 2, 'Spec and Doctrine both use it');
  assert.doesNotMatch(render, /citing\.map\(item =>/u, 'neither draws the full list');
});

test('view.x-io-spec-detail-order.clause-3-row-text-uses-the-sheet: clause 3: row text uses the sheet level-2 size and Proved by and Cited by share one quiet label column [N26]', () => {
  const css = file('main.css'), doctrine = file('doctrine.css');
  assert.match(css, /#spec-detail h2, #doctrine-detail h2 \{ font: 400 12\.5px\/1\.5 var\(--sans\); margin: 0; \}/u, 'the row text is 12.5px regular, the level-2 size');
  assert.doesNotMatch(css + doctrine, /#(spec|doctrine)-detail h2 \{[^}]*text-spec-title/u, 'the large title size is gone');
  assert.match(css, /\.spec-fact \{ display: grid; grid-template-columns: 76px minmax\(0, 1fr\);/u, 'every label shares one fixed column');
});
