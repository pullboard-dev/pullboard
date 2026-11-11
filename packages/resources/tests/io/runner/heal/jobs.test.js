import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../../apps/cli/tests/fixtures/board.js';
import { DatabaseSync } from 'node:sqlite';
import { healLeakedRunner } from '../../../../src/io/runner/heal.js';

const HOST = 'coreyolson@192.168.1.51';
const row = { host: HOST, since: '2026-11-06T01:16:00.000Z', detail: 'TRANSPORT_UNVERIFIED' };
const unhealthy = { healthy: false, step: 'worker readiness', reason: 'transport lost' };

/** A resource queue with one quarantined runner and the given live holders on it. */
function queueWith(holders) {
  const home = temporaryDirectory('pullboard-leak-live-');
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec(`CREATE TABLE runner_unavailable (host TEXT, since TEXT, detail TEXT, probe_token TEXT, probe_until INTEGER, healing INTEGER);
    CREATE TABLE holder (token TEXT, name TEXT, runner TEXT, item TEXT, pid INTEGER);
    CREATE TABLE runner_recovery_event (id TEXT, host TEXT, at TEXT, kind TEXT, detail TEXT)`);
  db.prepare('INSERT INTO runner_unavailable VALUES (?, ?, ?, ?, 0, 0)').run(HOST, row.since, row.detail, 'token-1');
  for (const id of holders) db.prepare('INSERT INTO holder VALUES (?, ?, ?, ?, ?)').run('tok-' + id, 'gate', HOST, id, 1);
  return { db, home };
}

test('clause 1: a quarantine heal on a runner with a holder never calls the leak stop and records the runner was busy [C7]', async () => {
  const { db, home } = queueWith(['live-1']);
  try {
    const proof = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => { throw new Error('leak probe must not run on a busy runner'); }, idleProbe: async () => unhealthy, token: 'token-1' });
    assert.equal(proof, unhealthy);
    const event = db.prepare('SELECT kind, detail FROM runner_recovery_event').get();
    assert.equal(event.kind, 'leak-stop-skipped');
    assert.match(JSON.parse(event.detail).reason, /busy/u);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
