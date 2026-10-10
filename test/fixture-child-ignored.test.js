/** Ignored-stderr IPC workers retain redacted nonzero and signal diagnostics [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

const fixtureCredential = randomUUID();
import { runFixtureChild, fixtureChildMessage } from './fixture-child.js';

/** Run a real ignored-stderr IPC worker inside a parent whose emitted diagnostics are captured. */
function ignoredWorkerProbe(outcome) {
  const helper = new URL('./fixture-child.js', import.meta.url).href;
  const worker = `process.stderr.write('ignored worker cause ' + process.env.PULLBOARD_TEST_SECRET + ' pm_fixtureWorkerToken\\n');
    process.send('ready');
    process.once('message', message => {
      if (message === 'nonzero') process.exit(17);
      else process.kill(process.pid, 'SIGTERM');
    });`;
  const parent = `import { startFixtureChild } from ${JSON.stringify(helper)};
    const child = startFixtureChild(process.execPath, ['-e', ${JSON.stringify(worker)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    const streams = { stderrIgnored: child.stderr === null, stdioIgnored: child.stdio[2] === null, ipcConnected: child.connected };
    const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
    child.send(${JSON.stringify(outcome)});
    const result = await closed;
    console.log(JSON.stringify({ ...result, ready, streams, failure: child.fixtureFailure }));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', parent], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_TEST_SECRET: fixtureCredential },
  });
  assert.equal(result.status, 0, fixtureChildMessage(result));
  return { result, worker: JSON.parse(result.stdout) };
}

/** Require both the returned worker context and the helper's emitted diagnostic to retain the cause. */
function assertIgnoredWorkerEvidence(probe, { status, signal }) {
  const { result, worker } = probe;
  assert.equal(worker.ready, 'ready', result.stderr);
  assert.deepEqual(worker.streams, { stderrIgnored: true, stdioIgnored: true, ipcConnected: true });
  assert.equal(worker.status, status, worker.failure);
  assert.equal(worker.signal, signal, worker.failure);
  for (const text of [worker.failure, result.stderr]) {
    assert.match(text, /command: .*node/u);
    assert.match(text, new RegExp(`status: ${status}`, 'u'));
    assert.match(text, new RegExp(`signal: ${signal ?? 'none'}`, 'u'));
    assert.match(text, /elapsed: \d+ms/u);
    assert.match(text, /stderr: ignored worker cause \[redacted\] \[redacted-token\]/u);
    assert.equal(text.includes(fixtureCredential), false);
    assert.doesNotMatch(text, /pm_fixtureWorkerToken/u);
  }
}

test('an ignored-stderr IPC fixture worker reports its nonzero exit without losing its cause [C7]', () => {
  assertIgnoredWorkerEvidence(ignoredWorkerProbe('nonzero'), { status: 17, signal: null });
});

test('an ignored-stderr IPC fixture worker reports its signal without losing its cause [C7]', () => {
  assertIgnoredWorkerEvidence(ignoredWorkerProbe('signal'), { status: null, signal: 'SIGTERM' });
});
