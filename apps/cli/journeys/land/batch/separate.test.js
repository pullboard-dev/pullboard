/** Independently scheduled large landing batch [B3,R3,E26,E29]. */
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { assertWholeQueueBatch } from '../../../tests/fixtures/land/batch.js';
import {
  json,
  onBoard,
} from '../../../tests/fixtures/land/board.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('separate publication batches all sixteen waiting items and bisects a red quick gate locally [B3,R3,E26,E29] [clause 1] [clause 2]', { timeout: 300_000 }, // budget: sixteen real private submit/accept cycles plus logarithmic red isolation; hang ceiling only.
() => assertWholeQueueBatch({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, { separate: true }));

