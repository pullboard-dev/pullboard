/** One unverified cleanup costs one runner slot, runner jobs start no detached watcher, and a held pool lock never fails a gate [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from '../packages/resources/index.js';
import { recordRunnerFailure } from '../packages/resources/index.js';
import { initializeRunnerRecovery } from '../packages/resources/index.js';
import { openPoolReadOnly } from '../packages/resources/index.js';
import { scopedEnvironment } from '../apps/runner/src/shell/runner-worker-environment.js';
import { scheduleWorktreeMaintenance } from '../src/worktree-maintenance-scheduler.js';
import { scheduleToolBuildGate } from '../src/tool-build-scheduler.js';

/** Point machine admission at a disposable machine home for one test, restoring the environment after. */
function machine(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-slot-quarantine-'));
  const home = join(dir, 'machine');
  mkdirSync(home, { recursive: true });
  const values = { PULLBOARD_MACHINE_HOME: home, ...extra };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, pool: join(home, 'resources.sqlite') };
}

/** Take a real runner-only gate lease from the given runners. */
function acquire(dir, runners, extra = {}) {
  return takeResource({ name: 'gate', capacity: 1, browserCapacityProvider: () => 1, scope: 'machine', root: dir,
    agent: 'fixture-slot-quarantine', remote: true, runnerOnly: true, runnerWaitMs: 10_000, runnerProvider: () => runners, ...extra });
}

/** Record one job's unverified cleanup on a host, as a RUNNER_CLEANUP_TIMEOUT requeue does. */
function cleanupTimedOut(pool, host, times = 1) {
  const db = new DatabaseSync(pool);
  try {
    initializeRunnerRecovery(db);
    for (let n = 0; n < times; n++) recordRunnerFailure(db, host, 'cleanup-unverified', { reason: 'cleanup-timeout' });
  } finally { db.close(); }
}

/** Count lease rows for one runner in the pool. */
function holders(pool, host) {
  const db = new DatabaseSync(pool, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM holder WHERE name = ?').get(`runner:${host}`).n; } finally { db.close(); }
}

test('a runner whose one cleanup timed out still admits a job on its free slots [C7]', async t => {
  const { dir, pool } = machine(t);
  const runners = [{ host: 'loaded-host', slots: 3, browser: 0 }];
  (await acquire(dir, runners)).release();
  cleanupTimedOut(pool, 'loaded-host');
  const first = await acquire(dir, runners);
  const second = await acquire(dir, runners);
  try {
    assert.equal(first.runner.host, 'loaded-host');
    assert.equal(second.runner.host, 'loaded-host', 'two of three slots stay usable while one cleanup is unproven');
    let settled = false;
    const third = acquire(dir, runners, { runnerWaitMs: 60_000, onWait: () => {} });
    third.then(lease => { settled = true; lease.release(); }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the unproven job still costs its own slot');
    first.release();
    await third;
  } finally { second.release(); first.release(); }
});

test('a runner is quarantined only once unverified cleanups cost every slot [C7]', async t => {
  const { dir, pool } = machine(t);
  const runners = [{ host: 'spent-host', slots: 2, browser: 0 }, { host: 'other-host', slots: 2, browser: 0 }];
  (await acquire(dir, runners)).release();
  cleanupTimedOut(pool, 'spent-host', 2);
  const lease = await acquire(dir, runners);
  try {
    assert.equal(lease.runner.host, 'other-host');
    assert.equal(holders(pool, 'spent-host'), 0);
  } finally { lease.release(); }
});

test('a runner job is marked, and the CLI starts no detached watcher inside it [C7]', async t => {
  const env = scopedEnvironment({ safePath: '/usr/bin:/bin', workerId: 'job-7' }, '/home', '/tmp', '', null, { gateSlotEnvironment: () => ({}) });
  assert.equal(env.PULLBOARD_RUNNER_JOB, 'job-7');
  machine(t, { PULLBOARD_RUNNER_JOB: env.PULLBOARD_RUNNER_JOB });
  assert.deepEqual(await scheduleWorktreeMaintenance({ config: { worktreeMaintenance: { enabled: true } } }), { scheduled: false, reason: 'runner-job' });
  assert.deepEqual(await scheduleToolBuildGate({ config: { toolBuild: { autoGate: true } } }), { scheduled: false, reason: 'runner-job' });
});

test('a gate whose slot release meets a held pool lock records its release once the lock clears [C7]', async t => {
  const { dir, pool } = machine(t, { PULLBOARD_SLOT_DB_LOCK_MS: '200' });
  const runners = [{ host: 'locked-host', slots: 2, browser: 0 }];
  const lease = await acquire(dir, runners);
  assert.equal(holders(pool, 'locked-host'), 1);
  const script = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');`
    + `process.stdout.write('locked\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},1500);`;
  const child = spawn(process.execPath, ['-e', script, pool], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => child.stdout.once('data', resolve));
  assert.throws(() => new DatabaseSync(pool, { readOnly: true }).prepare('SELECT 1 FROM holder').get(), /locked/u, 'the fixture really holds the lock');
  const reader = openPoolReadOnly(pool);
  try {
    lease.release();
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM holder').get().n, 0, 'the release committed after the lock cleared');
  } finally { reader.close(); }
  assert.equal(await exited, 0);
});
