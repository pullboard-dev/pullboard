/** Independently scheduled large landing batch [B3,R3,E26,E29]. */
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { assertWholeQueueBatch } from './land-batch-fixture.js';
import { json, onBoard } from './land-board-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('separate publication batches all sixteen waiting items and bisects a red quick gate locally [B3,R3,E26,E29]', { timeout: 300_000 }, // budget: sixteen real private submit/accept cycles plus logarithmic red isolation; hang ceiling only.
() => assertWholeQueueBatch({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, { separate: true }));

