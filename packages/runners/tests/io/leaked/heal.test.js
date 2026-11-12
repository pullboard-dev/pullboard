/** @pullboard-test-loads packages/resources/index.js packages/runners/src/io/leaked.js */
/** A quarantined runner with no holders stops its leaked job processes and heals itself within 60 s [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeRunnerRecovery } from '../../../../resources/index.js';
import { takeResource } from '../../../../resources/index.js';
import { updateRunnerSettings } from '../../../../resources/index.js';
import { recordRunnerFailure } from '../../../../resources/index.js';
import { recoverUnavailableRunners } from '../../../../resources/index.js';
import { stopLeakedRunnerJobs } from '../../../src/io/leaked.js';

/** The heal retry wait the resources cell documents for a runner with no holders: 30 s. */
const HEAL_RETRY_MS = 30_000;

/** Build a private runner root with an ssh stand-in that runs the remote command in a local shell, and a machine database file. */
function machine(t) {
  const dir = mkdtempSync(join(tmpdir(), 'self-heal-'));
  const root = join(dir, '.pullboard-runner'), bin = join(dir, 'bin');
  for (const path of [join(root, 'jobs', 'dead-job'), bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec sh -c "$1"\n');
  chmodSync(join(bin, 'ssh'), 0o700);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  const db = new DatabaseSync(join(dir, 'resources.sqlite'));
  db.exec(`CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL);
    CREATE TABLE holder(token TEXT PRIMARY KEY,name TEXT NOT NULL,pid INTEGER NOT NULL DEFAULT 0,agent TEXT NOT NULL DEFAULT '',repo TEXT NOT NULL DEFAULT '',since TEXT NOT NULL DEFAULT '',heartbeat INTEGER NOT NULL DEFAULT 0,runner TEXT NOT NULL DEFAULT '')`);
  initializeRunnerRecovery(db);
  const leaked = [];
  t.after(() => { process.env.PATH = saved; for (const child of leaked) child.kill('SIGKILL'); db.close(); rmSync(dir, { recursive: true, force: true }); });
  /** Leave one detached job process whose command line names a path under the jobs folder. */
  const leak = () => {
    const script = join(root, 'jobs', 'dead-job', 'maintenance-watch.js');
    writeFileSync(script, 'setInterval(() => {}, 60000);\n');
    const child = spawn(process.execPath, [script], { stdio: 'ignore', detached: true });
    leaked.push(child);
    return child.pid;
  };
  const alive = pid => { try { process.kill(pid, 0); return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() !== '' && !/^Z/u.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()); } catch { return false; } };
  /** Idle observation: healthy only when no process names the jobs folder. */
  const idleProbe = async runner => {
    const listing = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(line => line.includes(join(runner.root, 'jobs') + '/'));
    return listing.length ? { healthy: false, idle: false, writable: true, step: 'idle proof', reason: 'live process ' + listing[0].trim().split(/\s+/u)[0] }
      : { healthy: true, idle: true, writable: true, step: 'idle proof', reason: 'no live runner process' };
  };
  const runner = { host: 'fixture-host', root, slots: 1, browser: 0 };
  const quarantine = () => recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'controller orphan' });
  return { dir, db, runner, leak, alive, idleProbe, quarantine };
}

test('a quarantined runner with no holders and a leftover job process is restored and the process is gone [C7]', async t => {
  const m = machine(t), pid = m.leak();
  assert.ok(m.alive(pid));
  m.quarantine();
  const recovered = await recoverUnavailableRunners(m.db, [m.runner],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: Date.now() + 2000 });
  assert.equal(recovered, true);
  assert.equal(m.db.prepare('SELECT * FROM runner_unavailable').get(), undefined);
  assert.equal(m.alive(pid), false, 'the leftover job process was stopped');
  const event = m.db.prepare("SELECT detail FROM runner_recovery_event WHERE kind='leaked-jobs-stopped'").get();
  assert.deepEqual(JSON.parse(event.detail).stopped, [pid]);
  assert.deepEqual(m.db.prepare('SELECT kind FROM runner_recovery_event ORDER BY rowid').all().map(row => row.kind), ['unavailable', 'leaked-jobs-stopped', 'available']);
});

test('a quarantined runner with a live holder keeps its leftover process and stays out with that process named [C7]', async t => {
  const m = machine(t), pid = m.leak();
  m.db.prepare('INSERT INTO holder(token,name,runner) VALUES(?,?,?)').run('t1', 'runner:fixture-host', 'fixture-host');
  m.quarantine();
  const recovered = await recoverUnavailableRunners(m.db, [m.runner],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: Date.now() + 2000 });
  assert.equal(recovered, false);
  assert.ok(m.alive(pid), 'a runner with a holder is never touched');
  const held = m.db.prepare('SELECT * FROM runner_unavailable').get();
  assert.match(JSON.parse(held.failure).latestProbe.reason, new RegExp('live process ' + pid));
  assert.ok(held.probe_after - Date.now() > HEAL_RETRY_MS, 'a held runner keeps the long wait'); // budget: declared by the resources heal retry
});

test('a no-holder runner whose heal fails retries within 60 s, and an unreadable holder table is never zero [C7]', async t => {
  const m = machine(t), pid = m.leak();
  m.quarantine();
  const now = Date.now() + 2000;
  await recoverUnavailableRunners(m.db, [m.runner], { probe: async () => ({ healthy: false, step: 'cleanup' }),
    idleProbe: m.idleProbe, leakProbe: async () => ({ stopped: [] }), now });
  const held = m.db.prepare('SELECT * FROM runner_unavailable').get();
  assert.ok(held.probe_after - now <= HEAL_RETRY_MS, 'a no-holder runner retries within a minute'); // budget: declared by the resources heal retry
  assert.ok(m.alive(pid));
  m.db.exec('DROP TABLE holder');
  m.db.prepare('UPDATE runner_unavailable SET probe_after=0,probe_until=0').run();
  await recoverUnavailableRunners(m.db, [m.runner], { probe: async () => ({ healthy: false, step: 'cleanup' }),
    idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: now + 1 });
  assert.ok(m.alive(pid), 'without a readable holder table nothing is stopped');
  assert.equal(existsSync(m.runner.root), true);
});

test('a registration during the leaked job cleanup cannot clear the quarantine or admit work under the kill [C7]', async t => {
  const m = machine(t), pid = m.leak();
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = m.dir;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  m.quarantine();
  let during;
  const leakProbe = async runner => {
    updateRunnerSettings(runner.host, () => ({ ...runner }));
    during = m.db.prepare('SELECT host FROM runner_unavailable').get();
    return stopLeakedRunnerJobs(runner);
  };
  const recovered = await recoverUnavailableRunners(m.db, [m.runner],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe, now: Date.now() + 2000 });
  assert.equal(during?.host, m.runner.host, 'registration left the quarantine standing while cleanup ran');
  assert.equal(recovered, true);
  assert.equal(m.alive(pid), false);
});

/** Point machine admission at the fixture's own database for one test, restoring the environment afterwards. */
function useMachineHome(t, dir) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = dir;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
}

/** Ask the real admission queue for one runner-only gate lease from the given runners. */
function admit(dir, runners, runnerWaitMs) {
  return takeResource({ name: 'gate', capacity: 1, browserCapacityProvider: () => 1, scope: 'machine', root: dir,
    agent: 'fixture-self-heal', remote: true, runnerOnly: true, runnerWaitMs, runnerProvider: () => runners });
}

test('a multi-slot host admits no work while its leaked jobs are being stopped, then admits again [C7]', async t => {
  const m = machine(t), pid = m.leak();
  useMachineHome(t, m.dir);
  const runners = [{ ...m.runner, slots: 3 }];
  m.quarantine();
  let during;
  const leakProbe = async runner => {
    try { during = await admit(m.dir, runners, 1_000); } catch (error) { during = error; }
    return stopLeakedRunnerJobs(runner);
  };
  const recovered = await recoverUnavailableRunners(m.db, runners,
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe, now: Date.now() + 2000 });
  assert.equal(recovered, true);
  assert.equal(typeof during?.release, 'undefined', 'no lease was granted during the cleanup');
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM holder').get().n, 0, 'no holder was admitted during the cleanup');
  assert.equal(m.alive(pid), false);
  const after = await admit(m.dir, runners, 10_000);
  try { assert.equal(after.runner.host, m.runner.host, 'the healed host admits work again'); } finally { after.release(); }
});

test('recovery keeps the runner settings, node path and root, exactly as configured [C7]', async t => {
  const m = machine(t);
  m.leak();
  const configured = { ...m.runner, node: '/opt/fixture/bin/node', slots: 4, browser: 2 };
  const before = structuredClone(configured), seen = [];
  const leakProbe = async runner => { seen.push(structuredClone(runner)); return stopLeakedRunnerJobs(runner); };
  const idleProbe = async runner => { seen.push(structuredClone(runner)); return m.idleProbe(runner); };
  m.quarantine();
  const recovered = await recoverUnavailableRunners(m.db, [configured],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe, leakProbe, now: Date.now() + 2000 });
  assert.equal(recovered, true);
  assert.deepEqual(configured, before, 'the configured runner is unchanged after recovery');
  assert.ok(seen.length >= 3 && seen.every(runner => runner.node === before.node && runner.root === before.root), 'every probe saw the configured node path and root');
});
