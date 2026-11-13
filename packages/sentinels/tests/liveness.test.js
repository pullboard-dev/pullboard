/** @pullboard-test-input apps/cli/src/io/landing/automatic.js */
/** A landing worker that dies mid-batch is replaced by the health sweep and the adoption is recorded [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scheduleAutomaticLanding } from '../../landing/index.js';
import { resumeAutomaticLanding } from '../../landing/index.js';
import { recoverAutomaticLanding } from '../../landing/index.js';
import { automaticLandingDirectory } from '../../landing/index.js';
import { startServeSentinel } from '../index.js';
import { LANDING_LIVENESS_INTERVAL_MS } from '../index.js';
import { runFixtureGit } from '../../../apps/cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../apps/cli/tests/fixtures/child.js';

const GIT_START = ['init', '-q'];

/** An isolated real Git repository gives each private pending record its actual common directory. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-automatic-wake-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(GIT_START, { cwd: root });
  return root;
}

const worker = new URL('../../../apps/cli/src/io/landing/automatic.js', import.meta.url);
const dueAt = '2099-01-01T00:00:00.000Z';

/** Read only this fixture's private wake record; it is not a board proof receipt. */
function pending(root) { return JSON.parse(readFileSync(join(automaticLandingDirectory(root), 'pending.json'), 'utf8')); }

test('clause 1, clause 2: a dead landing worker mid-batch is replaced and the adoption names its pid and the gap [C7]', async t => {
  const root = fixture(t), schedule = async () => {}, timers = [];
  await scheduleAutomaticLanding(root, dueAt, worker, { schedule });
  const file = join(automaticLandingDirectory(root), 'pending.json');
  const gone = 4194301;
  writeFileSync(file, JSON.stringify({ ...pending(root), running: { pid: gone, started: 'Mon Jan  1 00:00:00 2001', at: new Date(Date.now() - 100_000).toISOString() } }));
  assert.equal(await recoverAutomaticLanding(root, worker, { schedule: async (...args) => timers.push(args) }), true);
  assert.equal(timers.length, 1, 'a replacement wake is scheduled by the sweep');
  assert.equal(pending(root).adopted.pid, gone);
  assert.ok(pending(root).adopted.gapSeconds >= 100, 'the unattended gap is recorded in seconds');
  assert.equal(pending(root).running, undefined, 'the dead worker no longer holds custody');
  let seen;
  await resumeAutomaticLanding(root, 'fixture-token', dueAt, async (_root, _wake, adopted) => { seen = adopted; }, { wait: async () => true });
  assert.equal(seen.pid, gone, 'the replacement receives the adoption to record on the batch');
});

test('the view sentinel checks landing liveness every minute, inside the two minute bar [C7]', async () => {
  const timers = []; const recovered = [];
  const observer = startServeSentinel({ projects: () => [{ root: '/one' }, { root: '/one' }], enabled: () => true,
    every: () => ({ unref() {} }), cancel: () => {},
    liveEvery: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; }, liveCancel: () => {},
    run: async () => {}, runCanary: async () => {}, canary: () => ({ close: async () => {} }),
    recover: async root => { recovered.push(root); } });
  const liveness = timers.find(timer => timer.ms === LANDING_LIVENESS_INTERVAL_MS);
  assert.ok(liveness && LANDING_LIVENESS_INTERVAL_MS <= 60_000, 'a pid check runs at least once a minute');
  await liveness.callback();
  assert.deepEqual(recovered, ['/one'], 'each board root is checked once per pass');
  await observer.close();
});
