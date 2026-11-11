/** @pullboard-test-input source-tree */
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
import { takeResource } from '../../../../packages/resources/index.js';
import { recordRunnerFailure } from '../../../../packages/resources/index.js';
import { initializeRunnerRecovery } from '../../../../packages/resources/index.js';
import { openPoolReadOnly } from '../../../../packages/resources/index.js';
import { recoverUnavailableRunners } from '../../../../packages/resources/index.js';
import { scopedEnvironment } from '../../../runner/src/io/worker/environment.js';
import { scheduleWorktreeMaintenance } from '../../src/io/worktree/maintenance/scheduler.js';
import { scheduleToolBuildGate } from '../../src/io/tool/build.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

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
  // The pool runs in WAL, where readers never wait on a writer, so the held lock shows as a refused write.
  assert.throws(() => {
    const probe = new DatabaseSync(pool);
    try { probe.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE'); } finally { probe.close(); }
  }, /locked/u, 'the fixture really holds the lock');
  const reader = openPoolReadOnly(pool);
  try {
    lease.release();
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM holder').get().n, 0, 'the release committed after the lock cleared');
  } finally { reader.close(); }
  assert.equal(await exited, 0);
});

test('a real CLI child of a runner job, with maintenance enabled, leaves no watcher behind [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const file = join(box.repo, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), worktreeMaintenance: { enabled: true, every: '1h', grace: '1d', exclude: [] } }));
  box.git(box.repo, 'add', '.');
  box.git(box.repo, 'commit', '-qm', 'test: enable the maintenance timer');
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const timer = join(common, 'pullboard', 'worktree-maintenance', 'timer.json');
  box.env.PULLBOARD_RUNNER_JOB = 'job-fixture';
  const marked = box.run(box.repo, 'status');
  assert.equal(marked.code, 0, marked.err || marked.out);
  assert.equal(existsSync(timer), false, 'a CLI inside a runner job registers no detached watcher');
  delete box.env.PULLBOARD_RUNNER_JOB;
  const plain = box.run(box.repo, 'status');
  assert.equal(plain.code, 0, plain.err || plain.out);
  assert.equal(existsSync(timer), true, 'the same command outside a job does start one, so the marker is what stops it');
  const owner = JSON.parse(readFileSync(timer, 'utf8'));
  try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone */ }
});

test('run-tests keeps the runner job marker for its test children [C7]', () => {
  const source = readFileSync(new URL('../../../../packages/gate/src/io/run-tests.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /delete env(?:\.PULLBOARD_RUNNER_JOB|\[['"]PULLBOARD_RUNNER_JOB['"]\])/u, 'test children and their CLI descendants stay marked');
});

test('one job recorded twice still costs one slot [C7]', async t => {
  const { dir, pool } = machine(t);
  const runners = [{ host: 'same-job-host', slots: 2, browser: 0 }, { host: 'fallback-host', slots: 2, browser: 0 }];
  (await acquire(dir, runners)).release();
  const recovery = { version: 1, launchFence: 1, request: 'job-twice', nonce: '00000000-0000-4000-8000-000000000002', tooling: 'b'.repeat(64) };
  const db = new DatabaseSync(pool);
  try {
    initializeRunnerRecovery(db);
    for (let n = 0; n < 2; n++) recordRunnerFailure(db, 'same-job-host', 'cleanup-unverified', { reason: 'cleanup-timeout', recovery });
  } finally { db.close(); }
  const lease = await acquire(dir, runners);
  try { assert.equal(lease.runner.host, 'same-job-host', 'its other slot stays usable'); } finally { lease.release(); }
});

test('a controller killed mid-job costs its runner one slot, and proving that exact job clears it [C7]', async t => {
  const { dir, pool } = machine(t);
  const runners = [{ host: 'shared-host', slots: 2, browser: 0 }];
  const resources = new URL('../../../../packages/resources/index.js', import.meta.url).href;
  const recovery = { version: 1, launchFence: 1, request: 'job-orphan-1', nonce: '00000000-0000-4000-8000-000000000001', tooling: 'a'.repeat(64) };
  const script = `const r=await import(${JSON.stringify(resources)});`
    + `const lease=await r.takeResource({name:'gate',capacity:1,browserCapacityProvider:()=>1,scope:'machine',root:${JSON.stringify(dir)},agent:'fixture-controller',remote:true,runnerOnly:true,runnerWaitMs:10000,runnerProvider:()=>${JSON.stringify(runners)}});`
    + `const custody=r.controllerDeadline({token:lease.token,pool:lease.pool},process.pid);custody.job(${JSON.stringify(recovery)});`
    + `process.stdout.write(lease.runner.host+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const host = await new Promise(resolve => child.stdout.once('data', data => resolve(String(data).trim())));
  assert.equal(host, 'shared-host');
  child.kill('SIGKILL');
  await exited;
  const lease = await acquire(dir, runners);
  try {
    assert.equal(lease.runner.host, 'shared-host', 'the runner keeps taking work after its controller died');
    const db = new DatabaseSync(pool);
    try {
      const row = db.prepare('SELECT detail, failure FROM runner_unavailable WHERE host = ?').get('shared-host');
      assert.equal(row.detail, 'CLEANUP_UNVERIFIED');
      assert.deepEqual(JSON.parse(row.failure).pending, [recovery], 'the orphan names its exact job');
      const probed = [];
      await recoverUnavailableRunners(db, runners, { now: Date.now() + 5_000,
        probe: async (runner, pending) => { probed.push(pending); return { healthy: true, step: 'health' }; } });
      assert.deepEqual(probed, [[recovery]], 'recovery checks that one job, not runner idleness');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable').get().n, 0);
    } finally { db.close(); }
  } finally { lease.release(); }
});
