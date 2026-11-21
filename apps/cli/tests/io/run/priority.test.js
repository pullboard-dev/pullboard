/** A test child process runs below the CLI's priority with gate.testNice on, and at the CLI's priority with it off [C7,#8509]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getPriority } from 'node:os';
import { test } from 'node:test';
import { TEST_NICE, lowerTestPriority } from '../../../src/io/run/priority.js';

/** Starts a long idle child at the CLI's priority, hands it to the check, and always stops it. */
async function withIdleChild(check) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { await check(child.pid); } finally { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
}

test('cli.io-run-priority.with-the-setting-on-a-test-child: clause 1: with the setting on, a test child process runs at a lower priority than the CLI [C7,#8509]', async () => {
  await withIdleChild(async pid => {
    assert.equal(lowerTestPriority(pid, { enabled: true }), true);
    const cli = getPriority(process.pid);
    // Children inherit a runner's nice value by design, so a CLI already at TEST_NICE has no lower value to compare against.
    if (cli < TEST_NICE) assert.ok(getPriority(pid) > cli, `child ${getPriority(pid)} vs CLI ${cli}`);
    assert.equal(getPriority(pid), TEST_NICE);
  });
});

test('cli.io-run-priority.with-the-setting-off-a-test-child: clause 2: with the setting off, a test child process keeps the CLI\'s priority [C7,#8509]', async () => {
  await withIdleChild(async pid => {
    assert.equal(lowerTestPriority(pid, { enabled: false }), false);
    assert.equal(getPriority(pid), getPriority(process.pid));
  });
});

test('cli.io-run-priority.a-refused-priority-change-leaves-the-process: a refused priority change leaves the process as it was and does not throw [C7,#8509]', () => {
  const refused = () => { throw new Error('EPERM'); };
  assert.equal(lowerTestPriority(0, { enabled: true, setPriority: refused }), false);
});

test('cli.io-run-priority.injected-set-priority-gets-test-nice: clause 2: lowerTestPriority calls the injected setPriority once with the pid and TEST_NICE, on a runner at any nice value [C7,#8509]', () => {
  const calls = [];
  assert.equal(lowerTestPriority(4242, { enabled: true, setPriority: (pid, priority) => calls.push([pid, priority]) }), true);
  assert.deepEqual(calls, [[4242, TEST_NICE]]);
});
