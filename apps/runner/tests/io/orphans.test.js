/** @pullboard-test-input apps/runner/src/io/scripts/worker.js */
/** A runner's idle proof costs a live controller job only its slot and stops a worker its controller lost [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runnerIdleReply } from '../../../../packages/runners/index.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { orphanObserver } from '../../src/io/orphans.js';

const CONTROLLER = '10.20.30.40';
const ORPHAN_AGE_MS = 10 * 60_000;

/**
 * A private runner root with a real pinned-worker entrypoint, a real resource pool, and the probe's own SSH client
 * address. Each worker is an actual Node process started from that entrypoint with the controller's SSH_CLIENT.
 */
function runner(t) {
  const fixture = privateFixtureFiles('pullboard-orphan-'), box = fixture.root;
  const root = join(box, 'runner'), machine = join(box, 'machine');
  const entry = join(root, 'runtime', 'a'.repeat(64), 'apps/runner/src/io/scripts/worker.js');
  mkdirSync(machine, { recursive: true });
  fixture.write(`runner/runtime/${'a'.repeat(64)}/src/runner-worker.js`, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);\n");
  const db = new DatabaseSync(join(machine, 'resources.sqlite'));
  db.exec('CREATE TABLE holder(token TEXT, name TEXT, pid INTEGER, agent TEXT, item TEXT, since TEXT)');
  const previous = { machine: process.env.PULLBOARD_MACHINE_HOME, client: process.env.SSH_CLIENT };
  process.env.PULLBOARD_MACHINE_HOME = machine;
  process.env.SSH_CLIENT = `${CONTROLLER} 50000 22`;
  const workers = [];
  t.after(() => {
    for (const child of workers) child.kill('SIGKILL');
    db.close();
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', previous.machine], ['SSH_CLIENT', previous.client]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(box, { recursive: true, force: true });
  });
  /** Start one worker process and record its runner-side gate holder for `item`. */
  const worker = async (item, { ageMs = ORPHAN_AGE_MS } = {}) => {
    const child = spawn(process.execPath, [entry], { cwd: box, stdio: 'ignore', env: { ...process.env, SSH_CLIENT: `${CONTROLLER} 50001 22` } });
    workers.push(child);
    await new Promise(resolve => child.once('spawn', resolve));
    db.prepare('INSERT INTO holder VALUES(?,?,?,?,?,?)').run(randomUUID(), 'gate', child.pid, `pullboard-ssh-${randomUUID()}`, item,
      new Date(Date.now() - ageMs).toISOString());
    return child;
  };
  return { root, worker };
}

/** An idle request as the controller's heal probe sends it. */
const request = liveJobs => ({ nonce: randomUUID(), idle: true, ...(liveJobs ? { liveJobs } : {}) });
/** The idle reply as the runner's health entry serves it, with the real process observer. */
const idleReply = (root, body) => runnerIdleReply(root, body, undefined, orphanObserver);

test('runner.orphans.a-worker-whose-controller-no-longer-holds: a worker whose controller no longer holds its job is stopped, and the next probe proves the runner idle [C7]', async t => {
  const box = runner(t);
  const orphan = await box.worker('2828');
  const exited = new Promise(resolve => orphan.once('exit', (code, signal) => resolve({ code, signal })));
  const reply = idleReply(box.root, request(['3001']));
  assert.equal(reply.idle, false);
  assert.deepEqual(reply.orphansStopped, [orphan.pid], 'the orphan worker is the one process signalled');
  assert.match(reply.reason, /orphaned runner worker stopped/u);
  // SIGTERM, which a real worker's signal custody turns into its own cleanup and lease release.
  const ended = await exited;
  assert.ok(ended.code === 0 || ended.signal === 'SIGTERM', JSON.stringify(ended));
  const after = idleReply(box.root, request(['3001']));
  assert.equal(after.idle, true, after.reason);
  assert.equal(after.writable, true);
});

test('runner.orphans.a-live-controller-job-costs-only-its: a live controller job costs only its own slot: the runner is proven idle for the free ones [C7]', async t => {
  const box = runner(t);
  const live = await box.worker('3001');
  const reply = idleReply(box.root, request(['3001']));
  assert.equal(reply.idle, true, reply.reason);
  assert.match(reply.reason, /free slots idle beside 1 live controller job/u);
  assert.equal(live.exitCode, null, 'the live job is never signalled');
  assert.equal(live.signalCode, null);
});

test('runner.orphans.without-a-live-job-list-or-for: without a live job list, or for a young holder, the whole-host idle proof is unchanged and nothing is stopped [C7]', async t => {
  const box = runner(t);
  const old = await box.worker('2828');
  const legacy = idleReply(box.root, request());
  assert.equal(legacy.idle, false);
  assert.equal(legacy.reason, 'runner resource lease is active', 'an older controller keeps the strict proof');
  old.kill('SIGKILL');
  await new Promise(resolve => old.once('exit', resolve));
  const young = await box.worker('2900', { ageMs: 1_000 });
  const reply = idleReply(box.root, request(['3001']));
  assert.equal(reply.idle, false);
  assert.equal(reply.reason, 'runner resource lease is active', 'a holder admitted after the live list was read is never judged');
  assert.equal(young.exitCode, null);
});
