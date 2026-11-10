/** Today's runner quarantines follow the transport cell's probe rule: one good probe lifts a doubt [C7,P7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { initializeRunnerRecovery } from '../../../../index.js';
import { probeQuarantined } from '../../../../index.js';
import { recordRunnerFailure } from '../../../../index.js';
import { recordRunnerProbe } from '../../../../index.js';
import { recoverUnavailableRunners } from '../../../../index.js';
import { runnerExcluded } from '../../../../index.js';

/** A real SQLite slot file holding the tables runner recovery reads. */
function slotDatabase() {
  const files = privateFixtureFiles('pullboard-quarantine-probe-');
  files.write('slots.sqlite', '');
  const db = new DatabaseSync(`${files.root}/slots.sqlite`);
  db.exec(`CREATE TABLE runner_unavailable (host TEXT PRIMARY KEY, since TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE runner_draining (host TEXT PRIMARY KEY, runner TEXT NOT NULL);
    CREATE TABLE holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, runner TEXT, item TEXT);`);
  initializeRunnerRecovery(db);
  return db;
}

/** The unavailable row for a host, or undefined. */
const rowFor = (db, host) => db.prepare('SELECT * FROM runner_unavailable WHERE host=?').get(host);

/** Whether admission keeps the host out, with four slots and one charge per unverified cleanup. */
const excluded = (db, host, now) => runnerExcluded(db, rowFor(db, host), { charges: new Map([[host, 1]]), slots: new Map([[host, 4]]), now });

test('clause 1: a runner whose probe passes leaves CLEANUP_UNVERIFIED and TRANSPORT_UNVERIFIED quarantine [C7,P7]', async () => {
  const db = slotDatabase();
  try {
    const start = Date.now();
    recordRunnerFailure(db, 'runner-a', 'cleanup-unverified', { reason: 'cleanup timed out' });
    recordRunnerFailure(db, 'runner-b', 'transport-lost', { reason: 'channel ended' });
    for (const host of ['runner-a', 'runner-b']) {
      recordRunnerProbe(db, host, false, start);
      recordRunnerProbe(db, host, false, start + 30_000);
      assert.equal(excluded(db, host, start), true, `${host} is quarantined by two failed probes 30 s apart`);
    }
    assert.deepEqual([rowFor(db, 'runner-a').detail, rowFor(db, 'runner-b').detail], ['CLEANUP_UNVERIFIED', 'TRANSPORT_UNVERIFIED']);

    // Both runners are busy: live gate leases hold them, so the old idle proof could never pass (7 Nov, .52).
    for (const host of ['runner-a', 'runner-b']) db.prepare('INSERT INTO holder VALUES(?,?,?,?)').run(`lease-${host}`, `runner:${host}`, host, '#1');
    const asked = [], idleAsked = [];
    const recovered = await recoverUnavailableRunners(db, [{ host: 'runner-a', slots: 4 }, { host: 'runner-b', slots: 4 }], {
      probe: async () => ({ healthy: false, step: 'worker readiness', reason: 'exact-job proof unavailable' }),
      idleProbe: async runner => { idleAsked.push(runner.host); return { healthy: false, step: 'idle proof', reason: 'runner resource lease is active' }; },
      transportProbe: async runner => { asked.push(runner.host); return { ok: true, host: runner.host }; },
      now: start + 60_000,
    });
    assert.equal(recovered, true);
    assert.deepEqual(asked.sort(), ['runner-a', 'runner-b'], 'each quarantined runner got one transport probe');
    assert.deepEqual(idleAsked, [], 'the idle proof never gates a runner its transport probe returned');
    assert.equal(rowFor(db, 'runner-a'), undefined, 'one good probe lifts CLEANUP_UNVERIFIED');
    assert.equal(rowFor(db, 'runner-b'), undefined, 'one good probe lifts TRANSPORT_UNVERIFIED');
    assert.equal(probeQuarantined(db, 'runner-a'), false);
    const lifted = db.prepare("SELECT detail FROM runner_recovery_event WHERE kind='available'").all().map(row => JSON.parse(row.detail).probe.step);
    assert.deepEqual(lifted, ['transport probe', 'transport probe']);
  } finally { db.close(); }
});

test('clause 1: a failed transport probe leaves the doubt to the existing recovery and records the failure [C7,P7]', async () => {
  const db = slotDatabase();
  try {
    recordRunnerFailure(db, 'runner-a', 'transport-lost', { reason: 'channel ended' });
    const now = Date.now() + 5_000;
    const recovered = await recoverUnavailableRunners(db, [{ host: 'runner-a', slots: 4 }], {
      probe: async () => ({ healthy: false, step: 'health', reason: 'still down' }),
      transportProbe: async () => ({ ok: false, reason: 'exit 255' }),
      now,
    });
    assert.equal(recovered, false);
    assert.equal(rowFor(db, 'runner-a').detail, 'TRANSPORT_UNVERIFIED');
    assert.deepEqual(db.prepare('SELECT at, ok FROM runner_probe WHERE host=?').all('runner-a').map(row => ({ ...row })), [{ at: now, ok: 0 }]);
    assert.equal(excluded(db, 'runner-a', now), false, 'one failed probe is not yet a quarantine');
  } finally { db.close(); }
});

test('clause 2: only two failed probes at least 30 s apart quarantine a runner [C7,P7]', () => {
  const db = slotDatabase();
  try {
    const start = Date.now();
    recordRunnerFailure(db, 'runner-a', 'cleanup-unverified', { reason: 'cleanup timed out' });
    recordRunnerFailure(db, 'runner-b', 'transport-lost', { reason: 'channel ended' });
    assert.equal(excluded(db, 'runner-a', start), false, 'a single cleanup doubt costs its slot and never quarantines the runner');
    assert.equal(excluded(db, 'runner-b', start), true, 'a lost transport waits for its first probe answer');
    for (const host of ['runner-a', 'runner-b']) {
      recordRunnerProbe(db, host, false, start + 1_000);
      assert.equal(excluded(db, host, start), false, `one failed probe after a doubt does not quarantine ${host}`);
      recordRunnerProbe(db, host, false, start);
      assert.equal(excluded(db, host, start), false, 'one failed probe does not quarantine');
      recordRunnerProbe(db, host, false, start + 29_999);
      assert.equal(excluded(db, host, start), false, 'two failures under 30 s apart do not quarantine');
      recordRunnerProbe(db, host, false, start + 30_000);
      assert.equal(excluded(db, host, start), true, 'failures 30 s apart quarantine');
      recordRunnerProbe(db, host, true, start + 31_000);
      recordRunnerProbe(db, host, false, start + 32_000);
      assert.equal(excluded(db, host, start), false, 'a good probe between failures resets the count');
    }

    const charges = new Map([['runner-a', 4]]), slots = new Map([['runner-a', 4]]);
    assert.equal(runnerExcluded(db, rowFor(db, 'runner-a'), { charges, slots, now: start }), true, 'a runner whose every slot is charged still takes no work');
    recordRunnerFailure(db, 'runner-c', 'worker-unresponsive', { reason: 'worker hung' });
    assert.equal(runnerExcluded(db, rowFor(db, 'runner-c'), { charges: new Map(), slots: new Map(), now: start }), true, 'other recorded failures keep their behaviour');
  } finally { db.close(); }
});
