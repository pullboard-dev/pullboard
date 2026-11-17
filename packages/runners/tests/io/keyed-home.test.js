/** @pullboard-test-input packages/runners/src/io/keyed.js packages/runners/src/io/source/scan.js packages/runners/src/io/module/parser.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: the clauses read the committed runner sources and the committed cells-edges ceiling. */
/** saveKeyedResult has one home, the pin cell's, and the runner callers reach it through the transport cell they already import [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

test('runners.keyed-home.packages-runners-src-io-keyed-js: clause 1: packages/runners/src/io/keyed.js defines no saveKeyedResult and pin defines the only one [C7]', () => {
  assert.doesNotMatch(read('packages/runners/src/io/keyed.js'), /function\s+saveKeyedResult\b|saveKeyedResult\s*=/u);
  assert.match(read('packages/pin/src/io/keyed.js'), /export function saveKeyedResult\b/u);
});

test('runners.keyed-home.scan-js-and-parser-js-import: clause 2: scan.js and parser.js import saveKeyedResult through the runner keyed module, which takes it from the transport cell, and the ceiling gains no runners-to-pin edge [C7]', () => {
  for (const file of ['packages/runners/src/io/source/scan.js', 'packages/runners/src/io/module/parser.js']) {
    assert.match(read(file), /import \{ saveKeyedResult \} from '\.\.\/keyed\.js';/u, file);
    assert.doesNotMatch(read(file), /pin\/index\.js/u, file);
  }
  assert.match(read('packages/runners/src/io/keyed.js'), /export \{ loadKeyedResult, saveKeyedResult \} from '\.\.\/\.\.\/\.\.\/transport\/index\.js';/u);
  const cells = JSON.parse(read('packages/gate/data/ceilings/cells-edges.json')).cells;
  assert.ok(!cells.runners.imports.includes('pin'), 'runners must not list pin');
});
