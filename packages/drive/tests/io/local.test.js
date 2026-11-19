/** @pullboard-test-input source-cell packages/drive */
/** A local runner started moments ago counts as on its way until it writes its own state, so a second command starts no second one [P7,C7,#10709]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { localRunnerStarting } from '../../index.js';
import { localRunnerState } from '../../index.js';
import { serveLocalRunner } from '../../index.js';
import { startLocalRunner } from '../../index.js';
import { testGit } from '../fixtures/git.js';
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

/** Serve the folder under one home with no boards, until the returned stop() is called; running settles with serveLocalRunner's answer. */
async function serveUnder(root, home) {
  const stop = new AbortController();
  const open = async () => ({ origin: 'http://127.0.0.1:9', key: 'k', boards: () => [], close: async () => {} });
  const running = serveLocalRunner({ folder: root, open, capabilities: [], git: testGit, signal: stop.signal, home, timing: { heartbeatMs: 600_000 } });
  // serveLocalRunner takes its lock and writes its state before its first await, so the state is there on return.
  return { running, stop: async () => { stop.abort(); return running; } };
}

test('drive.io-local.lock-per-home: clause 1: a runner and a starting marker of one PULLBOARD_HOME are not a live runner for another home on the same machine folder, and each home takes its own lock [P7,C7]', async t => {
  const root = folder(t);
  const a = await serveUnder(root, '/homes/a');
  assert.ok(localRunnerState(root, Date.now(), '/homes/a'), 'the home it started under sees it live');
  assert.equal(localRunnerState(root, Date.now(), '/homes/b'), null, 'another home sees no live runner');
  assert.equal(localRunnerState(root), null, 'a reader with no home sees none either');
  const b = await serveUnder(root, '/homes/b');
  assert.ok(localRunnerState(root, Date.now(), '/homes/b'), 'the second home took its own lock and runs');
  assert.notEqual(localRunnerState(root, Date.now(), '/homes/a').runner, localRunnerState(root, Date.now(), '/homes/b').runner);
  await a.stop();
  await b.stop();
  await startLocalRunner(root, ['runner', 'local'], { cwd: root, env: {}, home: '/homes/a', spawn: async () => ({ pid: process.pid }) });
  assert.equal(localRunnerStarting(root, Date.now(), '/homes/a'), process.pid);
  assert.equal(localRunnerStarting(root, Date.now(), '/homes/b'), null, 'another home is not starting');
});

test('drive.io-local.same-home-refusal-typed: clause 2: serveLocalRunner returns served false with a refusal code and a next line when the same home already holds the lock [P7,C7]', async t => {
  const root = folder(t);
  const first = await serveUnder(root, '/homes/a');
  const second = await serveLocalRunner({ folder: root, open: async () => assert.fail('a refused runner opens no API'), capabilities: [], git: testGit, signal: new AbortController().signal, home: '/homes/a' });
  assert.equal(second.served, false);
  assert.equal(second.code, 'LOCAL_RUNNER_RUNNING');
  assert.match(second.next, /pullboard runner list/u);
  assert.equal(second.pid, process.pid);
  assert.deepEqual(await first.stop(), { served: true, pid: process.pid });
});
