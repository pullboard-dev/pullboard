/** @pullboard-test-input source-cell codemap */
/** @pullboard-test-input packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** The committed plan's retired historical paths are absent from the tree, so main never refuses a submit CELLS_PLAN_RETIRED [C7,D3]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readPlan } from '../../../../../packages/codemap/index.js';
import { retiredProblems } from '../../../../../packages/codemap/index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

test('clause 1: no retired historical path exists or is imported on the committed tree [C7,D3]', () => {
  assert.deepEqual(retiredProblems(ROOT, readPlan(ROOT)), [], 'a file re-created at a retired target drops its retired row: edit packages/codemap/data/plan/cells.json');
});
