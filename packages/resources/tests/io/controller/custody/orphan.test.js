/** A dead runner controller requeues its job and leaves a healthy host in service; a failed probe still quarantines [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pruneControllerOrphans } from '../../../../src/io/controller/custody.js';
import { consumeControllerDisposition } from '../../../../src/io/controller/disposition.js';
import { initializeRunnerRecovery } from '../../../../index.js';
import { recordRunnerFailure } from '../../../../index.js';
import { recoverUnavailableRunners } from '../../../../index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';

const HOST = 'orphan-host';
const HOLDER = { pid: 4101, started: 'holder-start', controllerPid: 4102, controllerStarted: 'controller-start' };

/** Open a private pool holding one runner job whose controller is registered under the fixed holder identity. */
function pool(t) {
  const scratch = privateFixtureFiles('pullboard-orphan-pool-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(scratch.root, 'resources.sqlite'));
  db.exec(`CREATE TABLE resource(name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
    CREATE TABLE holder(token TEXT PRIMARY KEY,pid INTEGER,started TEXT,agent TEXT,repo TEXT,item TEXT,kind TEXT,runner TEXT,
      controller_identity TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL);`);
  db.prepare('INSERT INTO resource VALUES(?,?)').run(`runner:${HOST}`, 2);
  initializeRunnerRecovery(db);
  const identity = { version: 1, holderStarted: HOLDER.started, controllerPid: HOLDER.controllerPid, started: HOLDER.controllerStarted,
    recovery: { version: 1, request: 'job-one', nonce: randomUUID(), tooling: 'b'.repeat(64), launchFence: 1 } };
  db.prepare('INSERT INTO holder VALUES(?,?,?,?,?,?,?,?,?)')
    .run('lease-one', HOLDER.pid, HOLDER.started, 'agent', '/nowhere', '7', 'gate', HOST, JSON.stringify(identity));
  t.after(() => db.close());
  return db;
}

test('clause 1: a runner whose controller process is gone stays out of runner_unavailable and its job is requeued with the cause recorded [C7]', t => {
  const db = pool(t);
  // The holder process is alive; only the controller is gone, so the host itself is not at fault.
  const sameProcess = pid => pid === HOLDER.pid;
  pruneControllerOrphans(db, { sameProcess, recordRunnerFailure });
  assert.equal(db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(HOST), undefined, 'a dead controller does not quarantine its healthy host');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder WHERE token=?').get('lease-one').n, 0, 'the orphaned lease is released so the job requeues');
  const event = db.prepare("SELECT detail FROM runner_recovery_event WHERE host=? AND kind='orphan-requeued'").get(HOST)
    ;
  assert.ok(event, 'the requeue is recorded as a recovery event');
  const recorded = JSON.parse(db.prepare('SELECT diagnostic FROM runner_transport_error WHERE host=?').get(HOST).diagnostic);
  assert.equal(recorded.reason, 'controller-orphan');
  assert.equal(recorded.cause, 'controller process is gone', 'the cause is recorded with the requeue');
  // The queue transition that follows the prune finds the recorded disposition and consumes it exactly once.
  const owner = { token: 'lease-one', pid: HOLDER.pid, started: HOLDER.started, repo: '/nowhere', host: HOST };
  consumeControllerDisposition(db, owner, 'requeue');
  assert.throws(() => consumeControllerDisposition(db, owner, 'requeue'), { code: 'RESOURCE_LEASE_LOST' }, 'the disposition is consumed once');
});

test('clause 2: a runner that fails its probe is still quarantined and re-probed [C7]', async t => {
  const db = pool(t);
  recordRunnerFailure(db, HOST, 'worker-unresponsive', { reason: 'probe-failed' });
  assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(HOST).detail, 'WORKER_UNRESPONSIVE', 'a failed probe quarantines the host');
  const seen = [];
  const unhealthy = async configured => { seen.push(configured.host); return { healthy: false, step: 'worker readiness' }; };
  const runner = { host: HOST, slots: 2, browser: 0 };
  // A hung worker is re-probed every 300 s, so each pass lands past the previous pass's backoff.
  const base = Date.now();
  for (const pass of [1, 2]) {
    await recoverUnavailableRunners(db, [runner], { now: base + pass * 400_000, probe: unhealthy, idleProbe: unhealthy });
    assert.ok(db.prepare('SELECT 1 FROM runner_unavailable WHERE host=?').get(HOST), `pass ${pass}: the host stays quarantined while its probe fails`);
  }
  assert.ok(seen.length >= 2, 'the quarantined host was probed again on each pass');
});

test('clause 1: a holder killed together with its controller requeues its job and never holds the runner out of service [C7]', t => {
  const db = pool(t);
  // Both processes are gone, as when one `pullboard test` process is killed: nothing still drives the job.
  pruneControllerOrphans(db, { sameProcess: () => false, recordRunnerFailure });
  assert.equal(db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(HOST), undefined, 'the runner is never quarantined');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder WHERE token=?').get('lease-one').n, 0, 'the orphaned lease is released');
  assert.ok(db.prepare("SELECT 1 FROM runner_recovery_event WHERE host=? AND kind='orphan-requeued'").get(HOST), 'the requeue is recorded');
});

test('a dead holder whose controller still runs keeps the runner out until its cleanup is proven [C7]', t => {
  const db = pool(t);
  pruneControllerOrphans(db, { sameProcess: pid => pid === HOLDER.controllerPid, recordRunnerFailure });
  assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(HOST).detail, 'CLEANUP_UNVERIFIED');
});

test('clause 2: the 13 Nov hold ends at once: a killed seat on a runner that other jobs keep busy leaves it in service, so no wait outlasts its budget [C7]', t => {
  const db = pool(t);
  // As on 13 Nov 09:10 for a runner: item 7003's process (holder and controller in one) died while other seats' jobs held the host.
  const identity = { version: 1, holderStarted: 'other-start', controllerPid: 4202, started: 'other-controller',
    recovery: { version: 1, request: 'job-two', nonce: randomUUID(), tooling: 'c'.repeat(64), launchFence: 1 } };
  db.prepare('INSERT INTO holder VALUES(?,?,?,?,?,?,?,?,?)').run('lease-two', 4201, 'other-start', 'agent', '/nowhere', '7004', 'gate', HOST, JSON.stringify(identity));
  const gone = new Set([HOLDER.pid, HOLDER.controllerPid]);
  pruneControllerOrphans(db, { sameProcess: pid => !gone.has(pid), recordRunnerFailure });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable WHERE host=?').get(HOST).n, 0, 'the runner is never out, so nothing is held past the waiterMs budget');
  assert.deepEqual(db.prepare('SELECT token FROM holder WHERE runner=?').all(HOST).map(row => row.token), ['lease-two'], 'the live job keeps its lease');
});
