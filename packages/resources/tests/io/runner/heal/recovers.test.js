/** Requeue waiting runner jobs after a host is fully quarantined and preserve healthy controllers [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { controllerRegistrationPorts } from '../../../../src/io/controller/custody.js';
import { initializeRunnerRecovery } from '../../../../index.js';
import { RECOVERY_RETRY_MAX_MS } from '../../../../src/io/recovery.js';
import { RECOVERY_PASS_MS } from '../../../../src/io/recovery.js';
import { recordRunnerFailure } from '../../../../index.js';
import { recoverUnavailableRunners } from '../../../../index.js';
import { takeResource } from '../../../../index.js';

/** Open the private resource pool with exact holder/controller identities for quarantine tests. */
function pool(t, capacity = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'runner-quarantine-'));
  const file = join(directory, 'resources.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE resource(name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
    CREATE TABLE holder(token TEXT PRIMARY KEY,pid INTEGER,started TEXT,runner TEXT,controller_identity TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL);`);
  db.prepare('INSERT INTO resource VALUES(?,?)').run('runner:fixture-host', capacity);
  initializeRunnerRecovery(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, file };
}

/** Produce a fenced remote job identity that the runner recovery ledger accepts. */
function recovery(job) {
  return { version: 1, request: job, nonce: randomUUID(), tooling: 'a'.repeat(64), launchFence: 1 };
}

/** Point runner admission at a disposable machine pool, restoring the prior machine path afterwards. */
function machine(t) {
  const directory = mkdtempSync(join(tmpdir(), 'runner-quarantine-machine-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('resources.recovers.waiting-controllers-requeue-when-cleanup-failures: waiting controllers requeue when cleanup failures quarantine every runner slot [C7]', t => {
  const { db, file } = pool(t);
  const host = 'fixture-host';
  const owner = { pool: file, token: 'holder-1' };
  const identity = { version: 1, holderStarted: 'holder-start', controllerPid: process.pid, started: 'controller-start' };
  db.prepare('INSERT INTO holder(token,pid,started,runner,controller_identity) VALUES(?,?,?,?,?)')
    .run(owner.token, process.pid, identity.holderStarted, host, '');
  const ports = controllerRegistrationPorts({ pool: () => file, open: () => new DatabaseSync(file), update: (_db, work) => work(),
    processStarted: pid => pid === process.pid ? identity.started : '' });
  ports.registerController(owner, process.pid, identity);
  const observe = () => ports.observeUnavailable(owner, process.pid, identity);
  assert.equal(observe(), null, 'a healthy runner has no unavailable generation');

  recordRunnerFailure(db, host, 'cleanup-unverified', { recovery: recovery('job-one') });
  assert.equal(observe(), null, 'one unverified cleanup costs only its own slot');
  recordRunnerFailure(db, host, 'cleanup-unverified', { recovery: recovery('job-two') });
  assert.deepEqual(observe(), { host, since: db.prepare('SELECT since FROM runner_unavailable WHERE host=?').get(host).since,
    reason: 'CLEANUP_UNVERIFIED' }, 'controllers waiting for READY see the host once all configured slots are quarantined');
});

test('resources.recovers.leases-on-a-fully-quarantined-runner: leases on a fully quarantined runner requeue onto healthy runners [C7]', async t => {
  const directory = machine(t);
  const runners = [{ host: 'quarantine-host', slots: 2, browser: 0 }, { host: 'healthy-host', slots: 2, browser: 0 }];
  const options = { name: 'gate', capacity: 1, browserCapacityProvider: () => 1, scope: 'machine', root: directory,
    agent: 'runner-quarantine-fixture', remote: true, runnerOnly: true,
    requiredExecutor: { kind: 'ssh', host: 'quarantine-host' }, runnerProvider: () => runners };
  const first = await takeResource(options), second = await takeResource(options);
  const replacements = [];
  try {
    assert.equal(first.runner.host, 'quarantine-host');
    assert.equal(second.runner.host, 'quarantine-host');
    const db = new DatabaseSync(join(directory, 'resources.sqlite'));
    try {
      initializeRunnerRecovery(db);
      recordRunnerFailure(db, 'quarantine-host', 'cleanup-unverified', { recovery: recovery('job-one') });
      recordRunnerFailure(db, 'quarantine-host', 'cleanup-unverified', { recovery: recovery('job-two') });
    } finally { db.close(); }
    replacements.push(await first.requeueRunner('worker-unresponsive', { diagnostic: { recovery: recovery('job-one-retry') } }));
    replacements.push(await second.requeueRunner('worker-unresponsive', { diagnostic: { recovery: recovery('job-two-retry') } }));
    assert.deepEqual(replacements.map(lease => lease.runner.host), ['healthy-host', 'healthy-host']);
    const inspect = new DatabaseSync(join(directory, 'resources.sqlite'), { readOnly: true });
    try { assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM holder WHERE runner=?').get('quarantine-host').count, 0); }
    finally { inspect.close(); }
  } finally {
    first.release(); second.release();
    for (const lease of replacements) lease.release();
  }
});

test('resources.recovers.a-healed-runner-returns-with-its: a healed runner returns with its pinned node path and needs no manual heal script [C7]', async t => {
  const { db } = pool(t);
  const root = mkdtempSync(join(tmpdir(), 'runner-quarantine-pinned-root-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = { host: 'pinned-host', root, node: '/opt/pullboard/node-v22.13.1/bin/node', slots: 3, browser: 1 };
  const expected = structuredClone(runner), seen = [];
  recordRunnerFailure(db, runner.host, 'worker-unresponsive', { recovery: recovery('stranded-job') });
  const healed = await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2_000,
    probe: async configured => { seen.push(configured); return { healthy: false, step: 'worker readiness' }; },
    idleProbe: async configured => { seen.push(configured); return { healthy: true, idle: true, writable: true, reason: 'no live runner jobs remain' }; } });
  assert.equal(healed, true);
  assert.equal(db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(runner.host), undefined,
    'the recovered runner is registered for healthy admissions again');
  assert.ok(seen.length >= 2 && seen.every(configured => configured.node === expected.node && configured.root === expected.root),
    'health and idle probes use the configured node path and runner root');
  assert.deepEqual(runner, expected, 'self-heal leaves its pinned settings unchanged');
  assert.equal(existsSync(join(root, '.git', 'runner-heal.sh')), false, 'recovery does not depend on a person-run script');
});

/** The bar of #6823: a controller-lost runner is back in service within two minutes. */
const RECOVERY_BUDGET_MS = RECOVERY_RETRY_MAX_MS * 4;

test('resources.runner-heal-recovers.lost-controller-runner-returns-within-120-s: clause 1: a runner quarantined after its controller was lost is returned by the recovery pass within 120000 ms on the injected clock, even when the first pass hangs on every probe [C7,#6823]', async t => {
  const { db } = pool(t);
  const runner = { host: 'lost-controller-host', root: '/nonexistent/runner-lost-controller', slots: 1, browser: 0 };
  const lostAt = Date.now();
  // The controller was lost: no holder remains and the cleanup of its job is unproven, so the runner is quarantined CLEANUP_UNVERIFIED.
  recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'controller-lost', recovery: recovery('lost-controller-job') });
  const row = () => db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(runner.host);
  const asked = [];
  const answering = {
    probe: async () => ({ healthy: true, step: 'worker readiness' }),
    idleProbe: async () => ({ healthy: true, idle: true, writable: true, reason: 'no live runner jobs remain' }),
    leakProbe: async () => ({ ok: true, stopped: [] }) };
  // Pass 1 starts when the quarantine first allows a probe; every probe hangs, so only the injected deadline timer ends the pass.
  const firstAt = row().probe_after;
  const hung = await recoverUnavailableRunners(db, [runner], { now: firstAt, ...answering, probe: () => new Promise(() => {}),
    timer: (fire, ms) => { asked.push(ms); fire(); return 0; } });
  assert.equal(hung, false, 'a pass whose probes never settle returns no runner');
  assert.deepEqual(asked, [RECOVERY_PASS_MS], 'the pass asked for exactly one deadline');
  assert.ok(row(), 'the runner stays quarantined and is re-queued');
  // Pass 2 starts when the re-queued row allows it, with the runner answering again.
  const secondAt = row().probe_after;
  const healed = await recoverUnavailableRunners(db, [runner], { now: secondAt, ...answering });
  assert.equal(healed, true, 'the second pass returns the runner');
  assert.equal(row(), undefined, 'the runner is registered for admissions again');
  assert.ok(secondAt >= firstAt + RECOVERY_PASS_MS, 'the second pass starts after the first pass deadline');
  assert.equal(RECOVERY_BUDGET_MS, 120_000, 'the bar is two minutes: four retry intervals');
  const elapsed = secondAt - lostAt;
  assert.ok(elapsed <= RECOVERY_BUDGET_MS, `the runner returned ${elapsed} ms after the controller was lost`);
});
