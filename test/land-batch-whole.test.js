/** Independently scheduled large landing batch [B3,R3,E26,E29]. */
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { assertWholeQueueBatch } from './land-batch-fixture.js';
import { json, onBoard } from './land-board-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('land batches all waiting accepted items and bisects a red batch [B3,R3,E26,E29]', { timeout: 300_000 }, // budget: sixteen real private submits and accepts plus one bisected landing; hang ceiling only, no speed threshold.
() => assertWholeQueueBatch({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));

