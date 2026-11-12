/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads apps/cli/src/io/commands/next.js */
/** @pullboard-test-loads packages/jobs/src/io/test-run-queue.js */
/** A seat's pullboard test queues on the board and returns at once; next hands the result back; --wait blocks [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import {
  asSeatInside,
  runnerProject,
} from '../../../../tests/fixtures/runner/queued.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a seat call under a live outer pullboard command or machine variables blocks and returns red [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for two stand-in runner runs.
  const box = runnerProject(e2e);
  // This test process stands in for the live gate or check that started the call.
  const nested = asSeatInside(box, { PULLBOARD_CLI_PID: String(process.pid) }, 'test', 'test/red.test.js');
  assert.equal(nested.code, 1, `under a live pullboard command the run blocks and exits red: ${nested.out}${nested.err}`);
  assert.doesNotMatch(nested.out, /queued test run/u);
  const runnerJob = asSeatInside(box, { GIT_NO_REPLACE_OBJECTS: '1' }, 'test', 'test/red.test.js');
  assert.equal(runnerJob.code, 1, 'in the check runner\'s clean git environment the run blocks and exits red');
  assert.doesNotMatch(runnerJob.out, /queued test run/u);
});
