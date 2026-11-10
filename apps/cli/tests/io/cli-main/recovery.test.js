/** @pullboard-test-input source-tree */
/**
 * The handoff dispatcher's lock proves its loop is alive, an error out of the loop frees it, and a dispatcher in a
 * private machine home never touches ~/.pullboard or sweeps a board that never queued there [C7].
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mock } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drainHandoffQueue } from '../../../../../packages/resources/index.js';
import { dropHandoffTicket } from '../../../../../packages/resources/index.js';
import { ensureHandoffDispatcher } from '../../../../../packages/resources/index.js';
import { handoffQueueDirectory } from '../../../../../packages/resources/index.js';
import { listResources } from '../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../packages/resources/index.js';
import { recoverHandoffDispatcher } from '../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../packages/resources/index.js';
import { takeResource } from '../../../../../packages/resources/index.js';
import { recoverQueuedHandoffs } from '../../../src/io/cli-main/recovery.js';
import { wakesHandoffRecovery } from '../../../src/io/cli-main/run.js';
import { waitForCondition } from '../../fixtures/runner/holders.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** Every file and folder under `root` with its size and modification time, or null when `root` is missing. */
function treeState(root) {
  if (!existsSync(root)) return null;
  const rows = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      rows.push(`${path.slice(root.length)} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return rows;
}

/**
 * Run with a private machine home, a private account home whose ~/.pullboard is a locked sentinel, and a private Git
 * checkout to start dispatchers in, restoring the environment afterwards. The sentinel cannot be listed or entered
 * while the test runs, and the test fails if anything under it changed, so no machine path resolves outside the
 * temp home.
 */
async function withHome(action) {
  const dir = privateFixtureFiles('pullboard-dispatcher-live-').root;
  const user = join(dir, 'user');
  const sentinel = join(user, '.pullboard');
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, 'sentinel.txt'), 'untouched\n');
  const checkout = privateFixtureFiles('pullboard-dispatcher-checkout-').root;
  runFixtureGit(['-C', checkout, 'init', '-q']);
  const before = treeState(sentinel);
  const saved = { PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_MACHINE_HOME, HOME: process.env.HOME };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HOME = user;
  chmodSync(sentinel, 0o000);
  try {
    const result = await action(dir, checkout);
    chmodSync(sentinel, 0o700);
    assert.deepEqual(treeState(sentinel), before, 'nothing under the account ~/.pullboard was written');
    return result;
  } finally {
    chmodSync(sentinel, 0o700);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
}

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** The lock holder's heartbeat, read straight from the machine pool. */
function heartbeatOf(name) {
  const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT beat FROM holder WHERE name = ?').get(name).beat; }
  finally { db.close(); }
}

test('clause 1: a loop-driven lock heartbeat moves only when the loop renews it, so a wedged loop goes stale [C7]', () => withHome(async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const lock = await takeResource({ name: 'liveness-probe', capacity: 1, scope: 'machine', agent: 'probe', loopHeartbeat: true });
  try {
    const first = heartbeatOf('liveness-probe');
    mock.timers.tick(10_000); // far longer than the 3 s timer heartbeat
    assert.equal(heartbeatOf('liveness-probe'), first, 'no timer renews a loop-driven lock');
    lock.renew();
    assert.ok(heartbeatOf('liveness-probe') > first, 'the loop renews it');
  } finally { lock.release(); mock.timers.reset(); }
}));

test('clause 2: an error out of the drain loop releases the dispatcher lock and exits, and the next submit starts a fresh dispatcher at once [C7]', t => withHome(async (dir, checkout) => {
  mkdirSync(handoffQueueDirectory(), { recursive: true });
  writeFileSync(join(handoffQueueDirectory(), '0001-broken.json'), '{ not json');
  const entry = fileURLToPath(new URL('../../../../lib/src/io/handoff/dispatcher.js', import.meta.url));
  const run = spawnSync(process.execPath, [entry], { cwd: checkout, env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /HANDOFF_QUEUE_SOURCE|cannot read queued worker/u);
  const held = listResources({ scope: 'machine' }).find(row => row.name === 'submit-handoff-dispatcher');
  assert.ok(!held?.holders?.length, 'the dispatcher lock is free for the next submit to take');
  // The next submit: with the broken ticket gone and the lock free, ensureHandoffDispatcher launches a fresh dispatcher on that very call.
  rmSync(join(handoffQueueDirectory(), '0001-broken.json'), { force: true });
  const receipt = join(handoffQueueDirectory(), 'dispatcher.json');
  assert.ok(!existsSync(receipt), 'no dispatcher has been launched yet');
  await ensureHandoffDispatcher(fileURLToPath(new URL('../../../../../', import.meta.url)), checkout);
  const { pid } = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.ok(Number.isInteger(pid), 'a fresh dispatcher process was started');
  // The fresh dispatcher finds an empty queue and exits; the home is removed only after it, so nothing outlives the test.
  await waitForCondition(() => gone(pid), 'the fresh dispatcher exited', { signal: t.signal });
}));

test('clause 1: every machine path of the dispatcher runs stays inside the temp home, and ~/.pullboard is never read or written [C7]', t => withHome(async (dir, checkout) => {
  const entry = fileURLToPath(new URL('../../../../lib/src/io/handoff/dispatcher.js', import.meta.url));
  const run = spawnSync(process.execPath, [entry], { cwd: checkout, env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /EACCES|\.pullboard/u, 'the dispatcher never reached for the account ~/.pullboard');
  await ensureHandoffDispatcher(fileURLToPath(new URL('../../../../../', import.meta.url)), checkout);
  const { pid } = JSON.parse(readFileSync(join(handoffQueueDirectory(), 'dispatcher.json'), 'utf8'));
  await waitForCondition(() => gone(pid), 'the launched dispatcher exited', { signal: t.signal });
  assert.ok(handoffQueueDirectory().startsWith(join(dir, 'home')), 'the handoff queue is in the temp home');
  assert.ok(existsSync(join(dir, 'home', 'resources.sqlite')), 'the resources store is in the temp home');
  assert.ok(listResources({ scope: 'machine' }).some(row => row.name === 'submit-handoff-dispatcher'), 'the dispatcher lock lives in the temp home\'s store');
}));

test('clause 2: a dispatcher sweeps only boards that queued in its own machine home, never the checkout it started in [C7]', () => withHome(async (dir, checkout) => {
  const swept = [];
  const sweep = commonDir => { swept.push(commonDir); };
  await drainHandoffQueue({ capacity: 1, pollMs: 20, sweep });
  assert.deepEqual(swept, [], `a dispatcher started in ${process.cwd()} swept no board that never queued in its home`);
  // A repository that queued here stays swept after its ticket is gone, so a gone worker of its gates is still found.
  const queued = join(checkout, '.git');
  queueHandoffLaunch({ directory: join(dir, 'job'), tools: join(dir, 'tools'), commonDir: queued, job: 'job-3850' }, await reserveHandoffTicket('job-3850'));
  assert.equal(dropHandoffTicket('job-3850'), 1);
  await drainHandoffQueue({ capacity: 1, pollMs: 20, sweep });
  assert.deepEqual(swept, [queued], 'the board that queued in this home is swept, and only it');
  assert.ok(swept.every(path => path.startsWith(checkout)), 'no recovery resolves a board other than the one that queued here');
}));

/** Hold the launch lock as a second launcher would, for the length of an action. */
async function whileLaunchLockHeld(action) {
  const lock = await takeResource({ name: 'submit-handoff-dispatcher-launch', capacity: 1, scope: 'machine', agent: 'other-launcher' });
  try { return await action(); } finally { lock.release(); }
}

test('clause 1: while another process holds the launch lock, ensureHandoffDispatcher returns false at once [C7]', () => withHome(() => whileLaunchLockHeld(async () => {
  const started = Date.now();
  const launched = await ensureHandoffDispatcher(fileURLToPath(new URL('../../../../../', import.meta.url)), process.cwd());
  assert.equal(launched, false, 'a second launcher never queues behind the first');
  assert.ok(!existsSync(join(handoffQueueDirectory(), 'dispatcher.json')), 'it launched nothing');
  assert.ok(Date.now() - started < 1000, 'it did not wait for the lock'); // budget: hang ceiling; a wait would run for the whole lock hold, which this test never ends.
})));

test('clause 2: with the launch lock held, a queued-launch recovery from a board command returns in under 1 s [C7]', () => withHome(() => whileLaunchLockHeld(async () => {
  mkdirSync(handoffQueueDirectory(), { recursive: true });
  writeFileSync(join(handoffQueueDirectory(), '0001-queued.json'), JSON.stringify({ tools: fileURLToPath(new URL('../../../../../', import.meta.url)), commonDir: process.cwd(), job: 'queued' }));
  const started = Date.now();
  await recoverHandoffDispatcher({ loadStartOf: async () => () => '' });
  assert.ok(Date.now() - started < 1000, 'recovery does not queue behind the launcher that holds the lock'); // budget: declared by clause 2 of #3838 as under 1 s; a queued recovery would hang for the whole lock hold.
  assert.ok(!existsSync(join(handoffQueueDirectory(), 'dispatcher.json')), 'recovery launched nothing');
})));

/** Run one command line's recovery step as run-main does, against a private board, recording each detached check it starts. */
async function recoveryStep(dir, positionals) {
  const commonDir = join(dir, 'repo.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  writeFileSync(join(commonDir, 'pullboard', 'board.sqlite'), '');
  const starts = [];
  if (wakesHandoffRecovery(positionals)) {
    await recoverQueuedHandoffs({ cwd: dir, err() {} }, { repoInfo: () => ({ commonDir }) }, { start: (entry, options) => starts.push({ entry, options }) });
  }
  return starts;
}

/** Queue one captured launch file, as a submit does. */
function queueLaunch() {
  mkdirSync(handoffQueueDirectory(), { recursive: true });
  writeFileSync(join(handoffQueueDirectory(), '0001-queued.json'), JSON.stringify({ tools: fileURLToPath(new URL('../../../../../', import.meta.url)), commonDir: process.cwd(), job: 'queued' }));
}

test('#3839 clause 1: heartbeat, inbox and hook commit-msg never call recoverQueuedHandoffs, and leave a queued launch queued [C7]', () => withHome(async dir => {
  queueLaunch();
  for (const command of [['heartbeat'], ['inbox'], ['hook', 'commit-msg']]) {
    assert.deepEqual(await recoveryStep(dir, command), [], `${command.join(' ')} starts no recovery`);
  }
  assert.ok(existsSync(join(handoffQueueDirectory(), '0001-queued.json')), 'the launch stays queued');
  assert.ok(!existsSync(join(handoffQueueDirectory(), 'recovery-woken')), 'no command claimed a recovery turn');
}));

for (const command of [['next'], ['submit', '12']]) {
  test(`#3839 clause 1: ${command[0]} runs no recovery inline and hands it to the background job [C7]`, () => withHome(async dir => {
    queueLaunch();
    const starts = await recoveryStep(dir, command);
    assert.equal(starts.length, 1, `${command[0]} starts one recovery check`);
    assert.deepEqual(starts[0].options.args, ['--recover']);
    assert.equal(starts[0].entry, fileURLToPath(new URL('../../../../lib/src/io/handoff/dispatcher.js', import.meta.url)));
  }));
}
