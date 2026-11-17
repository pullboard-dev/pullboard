/** Complete timeout identities and a real detached test descendant exercise native cleanup [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupProcessText } from '../../../../../packages/runners/index.js';
import { readCleanupTimeoutDetails } from '../../../../../packages/runners/index.js';
import { createWorkerState } from '../../../src/io/worker/context.js';
import { createDescendantTracker } from '../../../index.js';
import { beginCleanup } from '../../../src/io/worker/cleanup.js';
import { reportCleanupTimeout } from '../../../src/io/worker/cleanup.js';
import { spawnOwned } from '../../../src/io/worker/process.js';
import { drainOwned } from '../../../src/io/worker/process.js';

/** A controlled POSIX observation supplies identity evidence without signalling synthetic PIDs. */
function row(pid, ppid, pgid) {
  return { pid, ppid, pgid, started: 'Mon Nov 2 01:00:00 2026', state: 'S', command: '/usr/bin/node' };
}

test('runner.cleanup.cleanup-timeout-receipt-and-refusal-name-every: cleanup timeout receipt and refusal name every waited-on process beyond sixteen [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pb-cleanup-evidence-'));
  const self = 9_100_001, root = self + 1;
  const rows = new Map([[self, row(self, 1, self)]]);
  const state = createWorkerState(import.meta.url);
  const tracker = createDescendantTracker(directory, { selfPid: self, census: () => new Map(rows) });
  t.after(() => { tracker.stopMonitoring(); rmSync(directory, { recursive: true, force: true }); });
  rows.set(root, row(root, self, root));
  tracker.registerRoot(root);
  tracker.observe();
  for (let index = 1; index <= 20; index++) rows.set(root + index, row(root + index, root, root + index));
  tracker.observe();
  assert.equal(tracker.cleanupState().live.length, 20);
  state.workerId = 'cleanup-evidence'; state.cleanupDirectory = directory;
  state.cleanupStage = 'descendants'; state.cleanupDetails = tracker.cleanupState; state.cleanupDeadline = 0;
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = chunk => { output += chunk; return true; };
  try { reportCleanupTimeout(state); reportCleanupTimeout(state); }
  finally { process.stderr.write = original; }
  const saved = JSON.parse(readFileSync(join(directory, 'cleanup-timeout.json'), 'utf8'));
  assert.equal(saved.processes.length, 21, 'the owned leader and all twenty detached descendants are retained');
  assert.ok(saved.processes.every(process => process.command === '/usr/bin/node' && process.started === row(1, 1, 1).started));
  const encoded = /^PULLBOARD_RUNNER_CLEANUP_DETAILS cleanup-evidence (.+)$/mu.exec(output)[1];
  const received = readCleanupTimeoutDetails(encoded, state.workerId);
  assert.deepEqual(received, saved);
  assert.equal(readCleanupTimeoutDetails(encoded, 'another-job'), null);
  assert.equal(readCleanupTimeoutDetails('not-json', state.workerId), null);
  const refusal = cleanupProcessText(received);
  for (const process of saved.processes) assert.ok(refusal.includes(`pid=${process.pid} command="/usr/bin/node" started="${process.started}"`));
  assert.equal(output.match(/^PULLBOARD_RUNNER_CLEANUP_TIMEOUT /gmu).length, 1);
});

test('runner.cleanup.a-real-test-ends-with-a-detached: a real test ends with a detached child and native worker cleanup drains it without a timeout [C7]', { timeout: 60_000 }, async t => { // budget: hang ceiling for the native child handshakes and drain.
  const directory = mkdtempSync(join(tmpdir(), 'pb-cleanup-child-'));
  const state = createWorkerState(import.meta.url);
  const tracker = createDescendantTracker(directory, { tick: () => reportCleanupTimeout(state), timedOut: () => state.cleanupTimedOut });
  state.activeDescendantTracker = tracker; state.cleanupDetails = tracker.cleanupState;
  const probe = join(directory, 'detached-test.mjs');
  writeFileSync(probe, `import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
after(() => process.disconnect());
test('runner.cleanup.leave-a-detached-child-for-native-cleanup: leave a detached child for native cleanup [C7]', async () => {
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); process.disconnect(); setInterval(() => {}, 1000);'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message'); child.unref();
  process.send({ pid: child.pid });
  await once(process, 'message');
});
`);
  const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, tracker.nodeOptions].filter(Boolean).join(' ') };
  delete env.NODE_TEST_CONTEXT;
  const record = spawnOwned(state, process.execPath, [probe], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const abort = () => record.child.kill('SIGTERM');
  t.signal.addEventListener('abort', abort, { once: true });
  let output = ''; record.child.stdout.on('data', chunk => { output += chunk; }); record.child.stderr.resume();
  try {
    const [message] = await once(record.child, 'message', { signal: t.signal });
    tracker.observe();
    const waiting = tracker.cleanupState().live.find(process => process.pid === message.pid);
    assert.ok(waiting);
    assert.ok(typeof waiting.command === 'string' && waiting.command.length > 0);
    assert.ok(typeof waiting.started === 'string' && waiting.started.length > 0);
    record.child.send('finish-test');
    assert.deepEqual(await record.closed, { code: 0, signal: null });
    assert.match(output, /# pass 1/u);
    beginCleanup(state);
    await tracker.stopDescendants(); await drainOwned(state, record); await tracker.verifyAfterGroups();
    assert.equal(state.ownedChildren.size, 0);
    assert.deepEqual(tracker.cleanupState().live, []);
    assert.deepEqual(tracker.cleanupState().pending, []);
    assert.equal(state.cleanupTimedOut, false);
  } finally {
    t.signal.removeEventListener('abort', abort);
    await drainOwned(state, record, true); await tracker.stopDescendants(); await tracker.verifyAfterGroups();
    tracker.stopMonitoring(); clearTimeout(state.cleanupTimer);
    rmSync(directory, { recursive: true, force: true });
  }
});
