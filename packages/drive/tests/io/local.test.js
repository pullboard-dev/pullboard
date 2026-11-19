/** @pullboard-test-input source-cell packages/drive */
/** A local runner started moments ago counts as on its way until it writes its own state, so a second command starts no second one [P7,C7,#10709]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { localRunnerStarting } from '../../index.js';
import { localRunnerState } from '../../index.js';
import { startLocalRunner } from '../../index.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';

/** A private runner folder, removed after the test. */
function folder(t) {
  const root = temporaryDirectory('pullboard-local-starting-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('drive.local.a-runner-started-moments-ago-is-starting: clause 1: a runner started moments ago, alive and with no state written yet, is reported as starting with its pid [P7,C7,#10709]', async t => {
  const root = folder(t);
  // This test process stands in for the started runner: alive, and it never writes the folder's state.
  const pid = await startLocalRunner(root, ['runner', 'local'], { cwd: root, env: {}, spawn: async () => ({ pid: process.pid }) });
  assert.equal(pid, process.pid);
  assert.equal(localRunnerState(root), null, 'the runner has written no state yet');
  assert.equal(localRunnerStarting(root), process.pid);
});

test('drive.local.a-dead-or-old-start-is-not-starting: clause 2: a start whose process is gone, or that is older than the 30 s stale budget, is not starting, so the next command starts a runner again [P7,C7,#10709]', async t => {
  const root = folder(t);
  await startLocalRunner(root, ['runner', 'local'], { cwd: root, env: {}, spawn: async () => ({ pid: process.pid }) });
  assert.equal(localRunnerStarting(root, Date.now() + 31_000), null, 'a start 31 s old is stale');
  const gone = folder(t);
  await startLocalRunner(gone, ['runner', 'local'], { cwd: gone, env: {}, spawn: async () => ({ pid: 2 ** 31 - 2 }) });
  assert.equal(localRunnerStarting(gone), null, 'a pid that names no process is not starting');
  const none = folder(t);
  assert.equal(await startLocalRunner(none, ['runner', 'local'], { cwd: none, env: {}, spawn: async () => ({ pid: null }) }), null);
  assert.equal(localRunnerStarting(none), null, 'a start that gave no pid leaves no marker');
});
