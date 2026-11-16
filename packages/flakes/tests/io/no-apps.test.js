/** @pullboard-test-input source-cell flakes gate */
/** @pullboard-world-pin: clause 1 reads the native flake source and the committed ceiling to prove no apps/ path remains. */
/** The native flake observer names no apps/ path, so its package-to-app ceiling row is gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('clause 1: native.js names no apps/ path and the committed ceiling holds no row for it [C7]', () => {
  assert.doesNotMatch(readFileSync(new URL('../../src/io/native.js', import.meta.url), 'utf8'), /apps\//u);
  const ceilings = JSON.parse(readFileSync(new URL('../../../gate/data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.equal(ceilings.packageApps['packages/flakes/src/io/native.js'], undefined);
});
