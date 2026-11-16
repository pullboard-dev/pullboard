/** A test child process runs below the CLI's priority with gate.testNice on, and at the CLI's priority with it off [C7,#8509]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getPriority } from 'node:os';
import { test } from 'node:test';
import { lowerTestPriority } from '../../../src/io/run/priority.js';

/** Starts a long idle child at the CLI's priority, hands it to the check, and always stops it. */
async function withIdleChild(check) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { await check(child.pid); } finally { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
}

test('clause 1: with the setting on, a test child process runs at a lower priority than the CLI [C7,#8509]', async () => {
  await withIdleChild(async pid => {
    assert.equal(lowerTestPriority(pid, { enabled: true }), true);
    assert.ok(getPriority(pid) > getPriority(process.pid), `child ${getPriority(pid)} vs CLI ${getPriority(process.pid)}`);
  });
});

test('clause 2: with the setting off, a test child process keeps the CLI\'s priority [C7,#8509]', async () => {
  await withIdleChild(async pid => {
    assert.equal(lowerTestPriority(pid, { enabled: false }), false);
    assert.equal(getPriority(pid), getPriority(process.pid));
  });
});

test('a refused priority change leaves the process as it was and does not throw [C7,#8509]', () => {
  const refused = () => { throw new Error('EPERM'); };
  assert.equal(lowerTestPriority(0, { enabled: true, setPriority: refused }), false);
});
