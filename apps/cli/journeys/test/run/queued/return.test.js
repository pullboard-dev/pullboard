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

test('a seat\'s pullboard test returns in under 1 s with a run id, and next hands back the red result [C7]', { timeout: 240_000 }, () => { // budget: hang ceiling for one stand-in runner run.
  const box = runnerProject(e2e);
  // Untimed set-up: one cheap seat call warms the file cache and node start-up, so the timed span below is the queue answer alone.
  assert.equal(asSeat(box, 'whoami').code, 0);
  const queued = asSeat(box, 'test', 'test/red.test.js', '--json');
  assert.equal(queued.code, 0, queued.err);
  assert.ok(queued.ms < 1000, `the seat's call returns at once (${Math.round(queued.ms)} ms)`); // budget: the queue answer, never the run.
  const ack = JSON.parse(queued.out);
  assert.equal(ack.queued, true);
  assert.match(ack.run, /^[0-9a-f-]{36}$/u, 'the answer carries the run id');
  assert.ok(['queued', 'running'].includes(ack.status));

  const status = asSeat(box, 'test', '--status', ack.run);
  assert.match(status.out, new RegExp(`test run ${ack.run} (queued|running|red)`, 'u'), 'status prints the run once');

  const next = asSeat(box, 'next');
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, new RegExp(`test run ${ack.run} red on ${HOST}`, 'u'), 'next hands back the outcome and where it ran');
  assert.match(next.out, /failing: .*red case/u, 'next names the failing test');
  assert.match(next.out, /log: \S+/u, 'next names the log');
  assert.doesNotMatch(asSeat(box, 'next').out, new RegExp(ack.run, 'u'), 'a run comes back once');
  const after = asSeat(box, 'test', '--status', ack.run, '--json');
  assert.equal(JSON.parse(after.out).status, 'red');
});
