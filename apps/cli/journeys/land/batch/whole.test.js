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
const { landProject, itemWorktreeLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures(e2e);

test('clause 1: land batches all waiting accepted items and bisects a red batch in log2(n) gates [B3,R3,E26,E29]', { timeout: 300_000 }, // budget: sixteen real private submits and accepts plus one bisected landing; hang ceiling only, no speed threshold.
() => assertWholeQueueBatch({ landProject, itemWorktreeLocal, submitItemLocal, acceptItemLocal, json, onBoard }));

