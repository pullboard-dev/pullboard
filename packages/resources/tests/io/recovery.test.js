/** Runner recovery skips a round on a locked slot database instead of ending the landing worker [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RECOVERY_RETRY_MAX_MS } from '../../src/io/recovery.js';
import { initializeRunnerRecovery } from '../../src/io/recovery.js';
import { recordRunnerFailure } from '../../src/io/recovery.js';
import { recoverUnavailableRunners } from '../../src/io/recovery.js';

/** The wait audit's waiterMs budget (packages/sentinels waitBudgets); a runner-unavailable wait answers to it [C7]. */
const WAITER_MS = 120_000;

/** A slot database whose one due unavailable runner cannot be claimed because the file is locked. */
function lockedDb(message) {
  const row = { host: 'runner-1', since: 1, failure: '{}', probe_after: 0, probe_until: 0 };
  return { prepare: sql => ({
    all: () => (/SELECT \* FROM runner_unavailable/u.test(sql) ? [row] : []),
    run: () => { throw new Error(message); },
  }) };
}

test('resources.recovery.a-locked-slot-database-skips-this: a locked slot database skips this recovery round and never throws [C7]', async () => {
  let probed = 0;
  const result = await recoverUnavailableRunners(lockedDb('database is locked'), [{ host: 'runner-1' }], { probe: async () => { probed += 1; return { healthy: true }; }, now: 10 });
  assert.equal(probed, 0, 'no probe runs for a runner the round could not claim');
  assert.notEqual(result, undefined);
});

test('resources.recovery.any-other-database-error-still-surfaces: any other database error still surfaces [C7]', async () => {
  await assert.rejects(recoverUnavailableRunners(lockedDb('no such table: runner_unavailable'), [{ host: 'runner-1' }], { probe: async () => ({ healthy: true }), now: 10 }), /no such table/u);
});

test('resources.recovery.a-studio-host-runner-held-cleanup: a studio-host runner held CLEANUP_UNVERIFIED by an orphaned controller is back within the 120 s waiterMs budget [C7]', async t => {
  // The evidence of #7214: studio-host went unavailable on a dead controller's cleanup and was held past five minutes
  // (14:51:21 to 14:59:04 on 13 Nov, with no recovery event between). Here its transport answers 60 s in, and the
  // passes run as the row schedules them; the hold must end on the first pass after that answer.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
  initializeRunnerRecovery(db);
  const runner = { host: 'studio-host', slots: 1, browser: 0 };
  const recovery = { version: 1, launchFence: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64) };
  recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'controller-orphan', phase: 'cleanup', cause: 'holder process is gone', remoteCleanup: 'unknown', recovery });
  const held = db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(runner.host);
  assert.equal(held.detail, 'CLEANUP_UNVERIFIED');
  const since = Date.parse(held.since), answersAt = since + 60_000;
  let now = since + 1_000, passes = 0, lastPass = since, longestGap = 0, probesAt = null;
  const options = () => ({
    now,
    probe: async () => ({ healthy: false, step: 'worker readiness', reason: 'pinned worker not ready' }),
    transportProbe: async () => ({ healthy: now >= answersAt }),
  });
  while (db.prepare('SELECT 1 FROM runner_unavailable WHERE host=?').get(runner.host)) {
    assert.ok(now - since <= WAITER_MS, `still held ${now - since} ms after it went unavailable, past the ${WAITER_MS} ms waiterMs budget (${passes} passes)`);
    await recoverUnavailableRunners(db, [runner], options());
    passes += 1;
    longestGap = Math.max(longestGap, now - lastPass);
    lastPass = now;
    const row = db.prepare('SELECT probe_after FROM runner_unavailable WHERE host=?').get(runner.host);
    if (row) now = Math.max(now + 1, row.probe_after);
    else probesAt = now;
  }
  assert.ok(probesAt - answersAt <= RECOVERY_RETRY_MAX_MS, `lifted ${probesAt - answersAt} ms after the transport answered`);
  assert.ok(longestGap <= RECOVERY_RETRY_MAX_MS, `passes ran at most ${RECOVERY_RETRY_MAX_MS} ms apart, saw ${longestGap}`);
  assert.deepEqual(db.prepare("SELECT kind FROM runner_recovery_event WHERE host='studio-host' ORDER BY rowid").all().map(row => row.kind).filter(kind => kind !== 'worker-probe-failed'), ['unavailable', 'available']);
});
