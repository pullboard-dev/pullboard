/** @pullboard-test-loads packages/resources/index.js packages/runners/src/shell/runner-leak-stop.js */
/** A quarantined runner with no holders stops its leaked job processes and heals itself within 60 s [C7]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from '../packages/resources/index.js';
import { stopLeakedRunnerJobs } from '../packages/runners/src/shell/runner-leak-stop.js';

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
    CREATE TABLE holder(token TEXT PRIMARY KEY,name TEXT NOT NULL,runner TEXT NOT NULL DEFAULT '')`);
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
  return { db, runner, leak, alive, idleProbe, quarantine };
}

/** Wait until a leaked pid is gone, so a kill that has been signalled but not yet reaped still counts. */
async function gone(alive, pid) {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  return !alive(pid);
}

test('a quarantined runner with no holders and a leftover job process is restored and the process is gone [C7]', async t => {
  const m = machine(t), pid = m.leak();
  assert.ok(m.alive(pid));
  m.quarantine();
  const started = Date.now();
  const recovered = await recoverUnavailableRunners(m.db, [m.runner],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: Date.now() + 2000 });
  assert.equal(recovered, true);
  assert.ok(Date.now() - started < 60_000);
  assert.equal(m.db.prepare('SELECT * FROM runner_unavailable').get(), undefined);
  assert.ok(await gone(m.alive, pid), 'the leftover job process was stopped');
  const event = m.db.prepare("SELECT detail FROM runner_recovery_event WHERE kind='leaked-jobs-stopped'").get();
  assert.deepEqual(JSON.parse(event.detail).stopped, [pid]);
  assert.deepEqual(m.db.prepare('SELECT kind FROM runner_recovery_event ORDER BY rowid').all().map(row => row.kind), ['unavailable', 'leaked-jobs-stopped', 'available']);
});

test('a quarantined runner with a live holder keeps its leftover process and stays out with that process named [C7]', async t => {
  const m = machine(t), pid = m.leak();
  m.db.prepare('INSERT INTO holder VALUES(?,?,?)').run('t1', 'runner:fixture-host', 'fixture-host');
  m.quarantine();
  const recovered = await recoverUnavailableRunners(m.db, [m.runner],
    { probe: async () => ({ healthy: false, step: 'cleanup' }), idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: Date.now() + 2000 });
  assert.equal(recovered, false);
  assert.ok(m.alive(pid), 'a runner with a holder is never touched');
  const held = m.db.prepare('SELECT * FROM runner_unavailable').get();
  assert.match(JSON.parse(held.failure).latestProbe.reason, new RegExp('live process ' + pid));
  assert.ok(held.probe_after - Date.now() > 200_000, 'a held runner keeps the long wait');
});

test('a no-holder runner whose heal fails retries within 60 s, and an unreadable holder table is never zero [C7]', async t => {
  const m = machine(t), pid = m.leak();
  m.quarantine();
  const now = Date.now() + 2000;
  await recoverUnavailableRunners(m.db, [m.runner], { probe: async () => ({ healthy: false, step: 'cleanup' }),
    idleProbe: m.idleProbe, leakProbe: async () => ({ stopped: [] }), now });
  const held = m.db.prepare('SELECT * FROM runner_unavailable').get();
  assert.ok(held.probe_after - now <= 30_000, 'a no-holder runner retries within a minute');
  assert.ok(m.alive(pid));
  m.db.exec('DROP TABLE holder');
  m.db.prepare('UPDATE runner_unavailable SET probe_after=0,probe_until=0').run();
  await recoverUnavailableRunners(m.db, [m.runner], { probe: async () => ({ healthy: false, step: 'cleanup' }),
    idleProbe: m.idleProbe, leakProbe: stopLeakedRunnerJobs, now: now + 1 });
  assert.ok(m.alive(pid), 'without a readable holder table nothing is stopped');
  assert.equal(existsSync(m.runner.root), true);
});
