/** A quarantined runner is probed and cleared on a queue with no gate waiting [C7,#8306]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { recoverIdleRunners } from '../../src/io/main.js';
import { recordRunnerFailure } from '../../src/io/recovery.js';

const RUNNER = { host: 'idle-runner', slots: 1, browser: 0 };

/** A real queue file holding one quarantined runner and no waiter or holder; returns the file and its quarantine time. */
async function quarantined(t) {
  const dir = privateFixtureFiles('pullboard-idle-recovery-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'resources.sqlite');
  await recoverIdleRunners([RUNNER], { file }); // creates the queue's tables
  const db = new DatabaseSync(file);
  try {
    const recovery = { version: 1, launchFence: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64) };
    recordRunnerFailure(db, RUNNER.host, 'cleanup-unverified', { reason: 'controller-orphan', phase: 'cleanup', cause: 'holder process is gone', remoteCleanup: 'unknown', recovery });
    const row = db.prepare('SELECT since,probe_after FROM runner_unavailable WHERE host=?').get(RUNNER.host);
    assert.ok(row, 'the runner is quarantined');
    assert.equal(db.prepare('SELECT count(*) AS n FROM waiter').get().n, 0, 'no gate waits');
    return { file, since: Date.parse(row.since), due: row.probe_after };
  } finally { db.close(); }
}

/** The quarantine row for the runner, read from the file. */
function unavailable(file) {
  const db = new DatabaseSync(file);
  try { return db.prepare('SELECT host,probe_after,probe_attempts FROM runner_unavailable WHERE host=?').get(RUNNER.host); } finally { db.close(); }
}

test('clause 1: a quarantined runner with no waiting gate gets a recovery probe within its probe interval [C7]', async t => {
  const { file, since, due } = await quarantined(t);
  let probes = 0;
  const failing = { probe: async () => { probes += 1; return { healthy: false, step: 'worker readiness', reason: 'not ready' }; }, transportProbe: async () => { probes += 1; return { healthy: false }; } };
  await recoverIdleRunners([RUNNER], { ...failing, file, now: Math.max(since, due) });
  assert.ok(probes > 0, 'a due quarantine is probed though nothing waits');
  const row = unavailable(file);
  assert.ok(row, 'a failed probe keeps the quarantine');
  assert.ok(row.probe_after - Math.max(since, due) <= 30_000, `the next probe is due within the 30 s retry cap, got ${row.probe_after - Math.max(since, due)} ms`);
  const before = probes;
  await recoverIdleRunners([RUNNER], { ...failing, file, now: Math.max(since, due) });
  assert.equal(probes, before, 'a runner not yet due is not probed again');
});

test('clause 2: a probe that answers clears the quarantine row with no gate involved [C7]', async t => {
  const { file, since, due } = await quarantined(t);
  const healthy = { probe: async () => ({ healthy: true }), transportProbe: async () => ({ healthy: true }) };
  const cleared = await recoverIdleRunners([RUNNER], { ...healthy, file, now: Math.max(since, due) });
  assert.equal(cleared, true, 'the pass reports a runner returned to service');
  assert.equal(unavailable(file), undefined, 'the quarantine row is gone');
  const db = new DatabaseSync(file);
  try { assert.ok(db.prepare("SELECT 1 FROM runner_recovery_event WHERE host=? AND kind='available'").get(RUNNER.host), 'the recovery is recorded'); } finally { db.close(); }
});
