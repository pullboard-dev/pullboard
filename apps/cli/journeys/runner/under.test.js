/** A loaded runner is not quarantined by a slow confirming probe, and a quarantined runner that answers heals by itself [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { confirmRunnerProbe } from '../../../../packages/resources/index.js';
import { CONFIRM_PROBE_MS } from '../../../../packages/resources/index.js';
import { CONFIRM_PROBE_RETRIES } from '../../../../packages/resources/index.js';
import { initializeRunnerRecovery } from '../../../../packages/resources/index.js';
import { recordRunnerFailure } from '../../../../packages/resources/index.js';
import { recoverUnavailableRunners } from '../../../../packages/resources/index.js';
import { probeRunnerTransport } from '../../../../packages/runners/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const HOST = 'loaded-runner';
const RUNNER = { host: HOST, slots: 4, browser: 0 };
/** No real pause between retries in the unit cases; the ssh case below uses real time. */
const noWait = async () => {};

/** Open a private slot database with the recovery tables the gate uses. */
function pool(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const db = new DatabaseSync(join(helpers.sandbox().dir, 'resources.sqlite'));
  db.exec(`CREATE TABLE holder(token TEXT PRIMARY KEY,pid INTEGER,started TEXT,agent TEXT,repo TEXT,item TEXT,kind TEXT,runner TEXT,name TEXT);
    CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL);`);
  initializeRunnerRecovery(db);
  t.after(() => db.close());
  return { db, helpers };
}

/** Record a failed call the way the gate does: the confirming probe's verdict decides the quarantine. */
async function failedCall(db, probe) {
  const health = await confirmRunnerProbe(probe, RUNNER, { wait: noWait });
  recordRunnerFailure(db, HOST, 'transport-lost', { reason: 'completion unavailable', confirmingProbe: health }, { quarantine: !health.healthy });
  return health;
}

test('clause 1: a runner whose confirming probe answers within 15 s, or on one of three retries, stays available; only failing every retry marks it unavailable [C7]', async t => {
  assert.equal(CONFIRM_PROBE_MS, 15_000, 'the confirming probe allows 15 s');
  assert.equal(CONFIRM_PROBE_RETRIES, 3, 'the confirming probe retries three times');
  {
    const { db } = pool(t);
    // At load the runner answers in 12 s: inside the 15 s budget, far outside the old 3 s one.
    const budgets = [];
    const slow = async (runner, { timeoutMs }) => { budgets.push(timeoutMs); return { healthy: timeoutMs >= 12_000 }; };
    const health = await failedCall(db, slow);
    assert.equal(health.healthy, true);
    assert.deepEqual(budgets, [15_000], 'one 15 s attempt answers');
    assert.equal(db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(HOST), undefined, 'a runner answering in 12 s stays available');
  }
  {
    const { db } = pool(t);
    // ssh dies in connect three times under load, then answers on the last retry.
    let calls = 0;
    const flaky = async () => { calls += 1; return { healthy: calls === 4, timedOut: calls < 4 }; };
    const health = await failedCall(db, flaky);
    assert.equal(calls, 4, 'the first probe and three retries ran');
    assert.equal(health.healthy, true);
    assert.deepEqual(health.attempts.map(attempt => attempt.healthy), [false, false, false, true], 'every attempt is recorded');
    assert.equal(db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(HOST), undefined, 'a runner answering on its third retry stays available');
  }
  {
    const { db } = pool(t);
    let calls = 0;
    const dead = async () => { calls += 1; throw new Error('ssh: connect to host loaded-runner port 22: Operation timed out'); };
    const health = await failedCall(db, dead);
    assert.equal(calls, 1 + CONFIRM_PROBE_RETRIES, 'a dead runner is tried on every retry first');
    assert.equal(health.healthy, false);
    assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(HOST)?.detail, 'TRANSPORT_UNVERIFIED', 'only a probe failing every retry marks the runner unavailable');
    const recorded = JSON.parse(db.prepare('SELECT failure FROM runner_unavailable WHERE host=?').get(HOST).failure);
    assert.equal(recorded.original.confirmingProbe.attempts.length, 4, 'the quarantine names every attempt');
  }
});

test('clause 1: the real ssh and Node confirming probe waits out a runner that answers in 4 s instead of timing out at 3 s [C7]', { timeout: 60_000 }, async t => {
  const { helpers } = pool(t);
  const bin = helpers.sandbox().dir;
  // A stand-in ssh that connects slowly, as a loaded runner did, then runs the remote Node command locally.
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, '#!/bin/sh\nfor arg; do [ "$arg" = "-O" ] && exit 0; done\nsleep 4\nfor last; do :; done\nexec /bin/sh -c "$last"\n');
  chmodSync(ssh, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const runner = { host: 'loaded-runner', node: process.execPath };
  const quick = await probeRunnerTransport(runner);
  assert.equal(quick.healthy, false, 'the old 3 s budget times out on a 4 s answer');
  assert.equal(quick.timedOut, true);
  const confirmed = await confirmRunnerProbe(probeRunnerTransport, runner, { wait: noWait });
  assert.equal(confirmed.healthy, true, 'the 15 s confirming probe hears the loaded runner answer');
  assert.equal(confirmed.attempts.length, 1, 'it answers on the first attempt');
  assert.ok(confirmed.attempts[0].ms >= 4_000 && confirmed.attempts[0].ms < CONFIRM_PROBE_MS, `answered in ${confirmed.attempts[0].ms} ms`);
  assert.ok(confirmed.command.includes('ConnectTimeout=14'), 'ssh is given a load-tolerant connect timeout');
});

/**
 * Run recovery passes on a virtual clock, one per second, until the row is gone or the limit passes.
 * Returns the virtual millisecond at which the runner returned, or null.
 */
async function healTime(db, options, { from, limit }) {
  for (let now = from; now <= from + limit; now += 1_000) {
    await recoverUnavailableRunners(db, [RUNNER], { ...options, now });
    if (!db.prepare('SELECT 1 FROM runner_unavailable WHERE host=?').get(HOST)) return now - from;
  }
  return null;
}

test('clause 2: a quarantined runner that answers a probe heals within 2 minutes without the coordinator [C7]', { timeout: 60_000 }, async t => {
  for (const [reason, detail] of [['transport-lost', 'TRANSPORT_UNVERIFIED'], ['cleanup-unverified', 'CLEANUP_UNVERIFIED'], ['worker-unresponsive', 'WORKER_UNRESPONSIVE']]) {
    const { db } = pool(t);
    recordRunnerFailure(db, HOST, reason, { reason: 'completion unavailable' });
    assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(HOST).detail, detail);
    const start = Date.now();
    // The runner is dark for its first three minutes, so recovery backs off as far as it will, then it answers.
    const answersAt = start + 180_000;
    let clock = start;
    const answering = () => clock >= answersAt;
    const transportProbe = async () => ({ ok: answering() });
    const probe = async () => answering() ? { healthy: true, step: 'cleanup', reason: 'exact-job cleanup verified' } : { healthy: false, step: 'worker readiness' };
    const idleProbe = async () => answering() ? { healthy: true, idle: true, writable: true, step: 'idle proof' } : { healthy: false, step: 'idle proof' };
    const options = { probe, idleProbe, restartProbe: idleProbe, transportProbe };
    for (; clock < answersAt; clock += 1_000) await recoverUnavailableRunners(db, [RUNNER], { ...options, now: clock });
    assert.ok(db.prepare('SELECT 1 FROM runner_unavailable WHERE host=?').get(HOST), `${detail}: the runner stays out while it does not answer`);
    const attempts = db.prepare('SELECT probe_attempts FROM runner_unavailable WHERE host=?').get(HOST).probe_attempts;
    assert.ok(attempts >= 3, `${detail}: recovery kept probing by itself (${attempts} passes)`);
    const healed = await healTime(db, { ...options, now: undefined }, { from: answersAt, limit: 120_000 });
    assert.notEqual(healed, null, `${detail}: an answering runner heals within 2 minutes`);
    assert.ok(healed <= 120_000, `${detail}: healed ${healed / 1_000} s after it answered`);
    const event = db.prepare("SELECT detail FROM runner_recovery_event WHERE host=? AND kind='available'").get(HOST);
    assert.equal(JSON.parse(event.detail).priorReason, detail, `${detail}: the return is recorded`);
  }
});
