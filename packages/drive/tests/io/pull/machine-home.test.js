/** A pulled job runs with its own machine home, so its test run never reads or takes the host's runner pools (#8361) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { jobEnvironment } from '../../../src/io/pull.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';

/** A throwaway runner cache folder, removed when the test ends. */
function cacheFolder(t) {
  const cache = temporaryDirectory('pullboard-job-machine-');
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  return cache;
}

/** Whether `path` lies inside `folder`. */
function inside(folder, path) {
  const rest = relative(folder, path);
  return rest !== '' && !rest.startsWith('..');
}

test('clause 1: a test process in a pulled job gets a machine pool inside its own job folder, never the host\'s runner pools [C7]', t => {
  const cache = cacheFolder(t);
  const real = join(cache, 'real-account', '.pullboard');
  const host = { PATH: '/usr/bin:/bin', HOME: join(cache, 'real-account'), PULLBOARD_MACHINE_HOME: real, PULLBOARD_ACCOUNT_HOME: join(cache, 'real-account') };
  const { env, folder } = jobEnvironment(cache, 'gate-1', 'gate:1:shard:1', host);
  assert.ok(env.PULLBOARD_MACHINE_HOME, 'the job names its machine home');
  assert.notEqual(env.PULLBOARD_MACHINE_HOME, real, 'the host\'s machine home, where its runners are registered, is not passed down');
  assert.ok(inside(folder, env.PULLBOARD_MACHINE_HOME), `${env.PULLBOARD_MACHINE_HOME} is inside the job folder ${folder}`);
  assert.equal(env.PULLBOARD_ACCOUNT_HOME, undefined, 'the host account home is not passed down either');
});

test('clause 2: a pulled gate shard on a runner whose service has no machine home still runs on its own pool, not the account\'s ~/.pullboard [C7]', t => {
  // 15 Nov: the local runner's service carried only PULLBOARD_ACCOUNT_HOME; its job had neither, read the OS account's
  // ~/.pullboard, and fanned its 10 files out onto the real runners' pools for 37 min.
  const cache = cacheFolder(t);
  const { env, folder } = jobEnvironment(cache, 'gate-8217-shard-16', 'gate:8217:shard:16', { PATH: '/usr/bin:/bin' });
  assert.equal(env.PULLBOARD_MACHINE_HOME, join(env.HOME, '.pullboard'), 'the job\'s machine home sits in the job\'s own HOME');
  assert.ok(inside(folder, env.PULLBOARD_MACHINE_HOME));
});
