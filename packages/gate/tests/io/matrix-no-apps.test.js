/** @pullboard-test-input packages/gate/src/io/matrix.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: the clauses read the matrix source and the committed ceiling to prove no apps/ path remains. */
/** The hop matrix names no apps/ path, so its package-to-app ceiling row is gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const FILE = 'packages/gate/src/io/matrix.js';

test('clause 1: matrix.js names no apps/ path [C7]', () => {
  assert.doesNotMatch(readFileSync(new URL(`../../../../${FILE}`, import.meta.url), 'utf8'), /apps\//u);
});

test('clause 2: the ceiling holds no packageApps row for matrix.js [C7]', () => {
  const ceilings = JSON.parse(readFileSync(new URL('../../data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.equal(ceilings.packageApps[FILE], undefined);
});
