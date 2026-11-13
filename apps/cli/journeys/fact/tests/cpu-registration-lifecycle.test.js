/** A local lifecycle helper in a readable false test keeps declared CPU load local [C7]. */
/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { cpuLoadFixture } from '../../../tests/fixtures/test.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

// AFTER-only: a fully readable lifecycle-only closure still proves ordinary work.
test('a readable false test with a local lifecycle helper stays local [C7]', async () => {
  const box = cpuLoadFixture(e2e, { lifecycleHelper: true, declaration: '{ cpuLoad: false }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
  assert.equal(local.executor?.cwd, box.repo);
});
