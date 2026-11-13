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
  asSeat,
  runnerProject,
} from '../../../../tests/fixtures/runner/queued.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a seat\'s green run comes back through next --take before its next item [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject(e2e);
  const queued = asSeat(box, 'test', 'test/green.test.js');
  assert.equal(queued.code, 0, queued.err);
  const id = /queued test run ([0-9a-f-]{36})/u.exec(queued.out)?.[1];
  assert.ok(id, `one line names the run: ${queued.out}`);
  assert.match(queued.out, /pullboard next/u, 'the line says the result comes through next');
  assert.doesNotMatch(queued.out + queued.err, /\b(wait|sleep|poll)\b/iu, 'nothing tells the seat to wait');
  const next = asSeat(box, 'next');
  assert.match(next.out, new RegExp(`test run ${id} green on ${HOST}`, 'u'));
});
