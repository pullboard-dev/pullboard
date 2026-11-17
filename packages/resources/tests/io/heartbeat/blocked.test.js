/**
 * A queued gate's entry stays alive while its wait loop probes unreachable runners, and a dead waiter is still
 * cleaned up [C7]. The queue is a real machine slot database; the probes are stubs that each move a mocked clock 45 s,
 * so three sequential probes span 135 s, past the 120 s gate-waiter heartbeat limit.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  mock,
  test,
} from 'node:test';
import {
  recordRunnerFailure,
  takeResource,
} from '../../../index.js';

const PROBE_MS = 45_000;
const RUNNER = { host: 'fixture-runner', slots: 1, browser: 0 };

/** Open the slot database the way a second process would, waiting out the pool's own writes. */
function queue(home) {
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

test('resources.blocked.a-queued-gate-keeps-its-queue: clause 1: a queued gate keeps its queue entry through 135 s of sequential runner probes, and its next renewal succeeds [C7]', async (t) => {
  const home = privateFixtureFiles('pb-probe-heartbeat-').root;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    mock.timers.reset();
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'holder-a', repo: home });
  const db = queue(home);
  t.after(() => db.close());
  // The only runner is down with a pinned worker that will not answer: recovery probes readiness, idle and restart in turn.
  const recovery = { version: 1, launchFence: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64) };
  db.exec('BEGIN IMMEDIATE');
  recordRunnerFailure(db, RUNNER.host, 'worker-unresponsive', { reason: 'fixture runner is unreachable', recovery });
  db.exec('COMMIT');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const probes = [];
  /** A stub probe that takes 45 s of the mocked clock and finds the runner still down. */
  const slowProbe = (step) => async () => {
    mock.timers.tick(PROBE_MS);
    probes.push(step);
    return { healthy: false, step, reason: 'unreachable' };
  };
  const renewals = [];
  let admitted;
  /** Each poll's item renewal: record the waiter's ticket and, once the probes have run, free the held slot. */
  const onWait = async (state) => {
    if (state.admitted) return { leaseUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const row = db.prepare("SELECT ticket FROM waiter WHERE agent = 'waiter-b'").get();
    renewals.push({ probes: probes.length, ticket: row?.ticket ?? null });
    if (probes.length >= 3 && renewals.filter(entry => entry.probes >= 3).length === 1) held.release();
    return { leaseUntil: new Date(Date.now() + 3_600_000).toISOString() };
  };
  try {
    admitted = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'waiter-b', repo: home,
      runnerProvider: () => [RUNNER], onWait,
      runnerHealthProbe: slowProbe('worker readiness'), runnerIdleProbe: slowProbe('idle proof'), runnerRestartProbe: slowProbe('idle proof') });
  } finally { mock.timers.reset(); }
  assert.deepEqual(probes.slice(0, 3), ['worker readiness', 'idle proof', 'idle proof'], 'three probes ran one after another');
  const before = renewals.find(entry => entry.probes === 0);
  const afterProbes = renewals.find(entry => entry.probes >= 3);
  assert.ok(before?.ticket, 'the gate was queued before the probes');
  assert.ok(afterProbes, 'its lease was renewed after the probes');
  assert.equal(afterProbes.ticket, before.ticket, 'the queue entry survived 135 s of probes with its place, never deleted and rejoined');
  assert.equal(admitted.name, 'gate', 'the waiting gate was admitted once the slot freed');
  admitted.release();
});

test('resources.blocked.a-queued-gate-whose-process-is: clause 2: a queued gate whose process is gone is still removed from the queue [C7]', async (t) => {
  const home = privateFixtureFiles('pb-probe-heartbeat-').root;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'holder-a', repo: home });
  const db = queue(home);
  t.after(() => db.close());
  let planted = false;
  let seenAfter = null;
  /** Plant a copy of this waiter owned by an exited process, then watch the next poll remove it and free the slot. */
  const onWait = async (state) => {
    if (state.admitted) return undefined;
    if (!planted) {
      const columns = db.prepare('PRAGMA table_info(waiter)').all().map(column => column.name).filter(name => name !== 'ticket');
      const copied = columns.map(name => name === 'token' ? '?' : name === 'pid' ? '?' : name === 'agent' ? "'dead-gate'" : name).join(', ');
      db.prepare(`INSERT INTO waiter (${columns.join(', ')}) SELECT ${copied} FROM waiter WHERE agent = 'waiter-b'`).run(randomUUID(), deadPid());
      planted = true;
      return undefined;
    }
    if (seenAfter === null) {
      seenAfter = db.prepare("SELECT COUNT(*) AS n FROM waiter WHERE agent = 'dead-gate'").get().n;
      held.release();
    }
    return undefined;
  };
  const admitted = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'waiter-b', repo: home,
    runnerProvider: () => [RUNNER], runnerHealthProbe: async () => ({ healthy: false, step: 'worker readiness', reason: 'unreachable' }), onWait });
  assert.equal(planted, true, 'the dead waiter was planted while the gate waited');
  assert.equal(seenAfter, 0, 'the next poll removed the waiter whose process had exited');
  admitted.release();
});
