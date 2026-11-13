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
  HOST,
  runnerProject,
} from '../../../../tests/fixtures/runner/queued.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('--wait still blocks for a non-seat caller and prints the result itself [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject(e2e);
  const ran = box.run(box.web, 'test', 'test/red.test.js', '--wait', '--json');
  assert.equal(ran.code, 1, 'the blocking run exits red');
  const result = JSON.parse(ran.out);
  assert.equal(result.runner, HOST, 'the files ran before the command returned');
  assert.equal(result.green, false);
  const plain = box.run(box.web, 'test', 'test/green.test.js');
  assert.equal(plain.code, 0, 'outside an agent session the call blocks as it always did');
  assert.match(plain.err, new RegExp(`green on ${HOST}`, 'u'));
});
