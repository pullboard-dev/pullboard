/** No command's default text grows past its size on merge-base main [C7,N26]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { createBudgetMeasure } from '../../tests/fixtures/budget-measure.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const { measure, mainTree, ratchetProblems, seeded } = createBudgetMeasure(helpers);

test('cli.journeys-inbox-growth.every-measured-command-prints-within-its: clause 1: every measured command prints within its main size on a seeded board [C7,N26]', async () => {
  const box = seeded();
  const main = mainTree();
  try {
    // The two trees are measured side by side so the file stays inside its time limit.
    const [headSizes, mainSizes] = await Promise.all([measure(box, helpers.BIN), main ? measure(box, join(main, 'apps/cli/pullboard.js')) : {}]);
    assert.deepEqual(ratchetProblems(headSizes, mainSizes), [], JSON.stringify(headSizes));
  } finally {
    if (main) rmSync(main, { recursive: true, force: true });
  }
});
