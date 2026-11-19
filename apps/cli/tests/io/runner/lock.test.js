/** One runner service per runner root: the cache folder's lock refuses a live second holder and takes over a dead one [P7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeRunnerLock } from '../../../src/io/runner/lock.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';

/** A private cache folder, and a start-time reader that knows only the pids in `running`. */
function cacheWith(t, running) {
  const { root } = privateFixtureFiles('pullboard-runner-lock-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cache: join(root, 'pull'), startOf: pid => running[pid] ?? '' };
}

test('cli.io-runner-lock.second-service-is-refused: clause 1: takeRunnerLock called twice for one runner folder returns the lock first, then refuses RUNNER_ALREADY_RUNNING naming the first holder pid and how it was started [P7]', t => {
  const { cache, startOf } = cacheWith(t, { 111: 'Wed Nov 19 07:00:00 2026', 222: 'Wed Nov 19 07:00:05 2026' });
  const first = takeRunnerLock(cache, { pid: 111, ppid: 1, env: { XPC_SERVICE_NAME: 'dev.pullboard.runner' }, startOf });
  assert.equal(first.holder.pid, 111);
  assert.throws(() => takeRunnerLock(cache, { pid: 222, ppid: 1, env: {}, startOf }), error => {
    assert.equal(error.code, 'RUNNER_ALREADY_RUNNING');
    assert.match(error.message, /pid 111/u);
    assert.match(error.message, /launchd dev\.pullboard\.runner/u);
    return true;
  });
  first.release();
  assert.equal(takeRunnerLock(cache, { pid: 222, ppid: 1, env: {}, startOf }).holder.pid, 222, 'a released lock can be taken');
});

test('cli.io-runner-lock.dead-holder-is-taken-over: clause 2: a lock file naming a pid that is not running, or whose start time does not match, is taken over and the new holder is recorded [P7]', t => {
  const { cache, startOf } = cacheWith(t, { 333: 'Wed Nov 19 08:00:00 2026', 444: 'Wed Nov 19 09:00:00 2026' });
  const first = takeRunnerLock(cache, { pid: 555, ppid: 7, env: {}, startOf });
  assert.equal(first.holder.pid, 555);
  const gone = takeRunnerLock(cache, { pid: 333, ppid: 8, env: {}, startOf });
  assert.equal(JSON.parse(readFileSync(gone.file, 'utf8')).pid, 333, 'pid 555 is not running, so its lock is taken over');
  writeFileSync(gone.file, JSON.stringify({ pid: 444, started: 'Wed Nov 19 01:00:00 2026', via: 'parent pid 1' }));
  const reused = takeRunnerLock(cache, { pid: 333, ppid: 9, env: {}, startOf });
  assert.deepEqual(JSON.parse(readFileSync(reused.file, 'utf8')), { pid: 333, started: 'Wed Nov 19 08:00:00 2026', via: 'parent pid 9' }, 'a reused pid with another start time is a dead holder');
});
