/** Recovery storage and wait projections live in the resources cell and receive observations through explicit ports [C7,Q1,Q2]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { initializeRunnerRecovery } from '../../../../index.js';
import { recordRunnerFailure } from '../../../../index.js';
import { recoverUnavailableRunners } from '../../../../index.js';
import { localWaitBranch } from '../../../../index.js';
import { runnerDeadlineLine } from '../../../../index.js';
import { runnerWaitReasons } from '../../../../index.js';

/** Create a real private resource database without opening machine settings, a board or a network connection. */
function queue(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-resource-ports-'));
  const db = new DatabaseSync(join(directory, 'resources.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec("CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)");
  initializeRunnerRecovery(db);
  return db;
}

/** Retain a synthetic exact-job identity so a private observation exercises the current custody contract. */
function due(db, { legacy = false } = {}) {
  const recovery = { version: 1, request: 'private-request', nonce: '11111111-1111-1111-1111-111111111111', tooling: 'a'.repeat(64) };
  recordRunnerFailure(db, 'private-runner', 'cleanup-unverified', legacy ? {} : { recovery });
  db.prepare('UPDATE runner_unavailable SET probe_after=0 WHERE host=?').run('private-runner');
  return recovery;
}

test('resource recovery has no implicit healthy observation when its caller supplies no probe [C7,Q1]', async t => {
  const db = queue(t);
  due(db);
  assert.equal(await recoverUnavailableRunners(db, [{ host: 'private-runner' }]), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable').get().n, 1);
});

test('a supplied observation receives exact custody and clears only its claimed resource generation [C7,Q2]', async t => {
  const db = queue(t);
  const recovery = due(db);
  let calls = 0;
  const changed = await recoverUnavailableRunners(db, [{ host: 'private-runner' }], {
    /** Observe only the caller-supplied private runner and its retained exact-job identity. */
    probe: async (runner, pending) => {
      assert.equal(runner.host, 'private-runner');
      assert.deepEqual(pending, [recovery]);
      calls++;
      return { healthy: true };
    },
  });
  assert.equal(changed, true);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_recovery_event WHERE kind='available'").get().n, 1);
});

test('a newer resource failure survives an older supplied healthy observation [C7,Q2]', async t => {
  const db = queue(t);
  const recovery = due(db);
  const changed = await recoverUnavailableRunners(db, [{ host: 'private-runner' }], {
    /** Record intervening uncertainty before returning the observation for the prior generation. */
    probe: async () => {
      recordRunnerFailure(db, 'private-runner', 'cleanup-unverified', { recovery, reason: 'new uncertainty' });
      return { healthy: true };
    },
  });
  assert.equal(changed, false);
  const retained = db.prepare('SELECT * FROM runner_unavailable').get();
  assert.equal(retained.probe_token, '');
  assert.equal(JSON.parse(retained.failure).original.reason, 'new uncertainty');
});

test('legacy custody and draining resources never reach the supplied observer [C7,Q2]', async t => {
  for (const mode of ['legacy', 'draining']) {
    const db = queue(t);
    due(db, { legacy: mode === 'legacy' });
    if (mode === 'draining') db.prepare('INSERT INTO runner_draining(host,runner) VALUES(?,?)').run('private-runner', '{}');
    let calls = 0;
    const changed = await recoverUnavailableRunners(db, [{ host: 'private-runner' }], {
      /** Protected state must not reach even this private observer. */
      probe: async () => { calls++; return { healthy: true }; },
    });
    assert.equal(changed, false, mode);
    assert.equal(calls, 0, mode);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable').get().n, 1, mode);
  }
});

test('wait projections read only the pool facts and name the recovery step without a probe [C7,Q2]', t => {
  const db = queue(t);
  db.exec('CREATE TABLE runner_gui(host TEXT PRIMARY KEY,gui INTEGER NOT NULL); CREATE TABLE holder(name TEXT,agent TEXT,item TEXT,browser INTEGER,timing INTEGER); CREATE TABLE runner_timing_drain(singleton INTEGER,host TEXT,token TEXT,agent TEXT,item TEXT)');
  due(db);
  const runners = [{ host: 'private-runner', slots: 1, browser: 0 }];
  const reasons = runnerWaitReasons(db, runners, { gui: 0, browser: 0, timing: 0 }, new Set(['private-runner']));
  assert.match(reasons[0].reason, /^unavailable \(cleanup or draining\); health: waiting for pinned-worker readiness/u);
  assert.equal(localWaitBranch({ capacity: 0, holders: [] }), 'no local capacity');
  assert.match(runnerDeadlineLine({ at: 0, branch: 'no local capacity', runners: reasons }), /^runner wait deadline 1970-01-01T00:00:00\.000Z passed; no local capacity; private-runner: unavailable/u);
});
