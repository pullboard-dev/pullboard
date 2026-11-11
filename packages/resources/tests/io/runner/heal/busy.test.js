import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { healLeakedRunner } from '../../../../src/io/runner/heal.js';

const HOST = 'coreyolson@192.168.1.51';

/** A resource queue with one quarantined runner and the given live holders on it. */
function queueWith(holders) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-leak-heal-'));
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec(`CREATE TABLE runner_unavailable (host TEXT, since TEXT, detail TEXT, probe_token TEXT, probe_until INTEGER, healing INTEGER);
    CREATE TABLE holder (name TEXT, runner TEXT, pid INTEGER);
    CREATE TABLE runner_recovery_event (id TEXT, host TEXT, at TEXT, kind TEXT, detail TEXT)`);
  db.prepare('INSERT INTO runner_unavailable VALUES (?, ?, ?, ?, 0, 0)').run(HOST, '2026-11-06T01:16:00.000Z', 'CLEANUP_UNVERIFIED', 'token-1');
  for (const pid of holders) db.prepare('INSERT INTO holder VALUES (?, ?, ?)').run('gate', HOST, pid);
  return { db, home };
}

const row = { host: HOST, since: '2026-11-06T01:16:00.000Z', detail: 'CLEANUP_UNVERIFIED' };
const unhealthy = { healthy: false, step: 'idle proof', reason: 'runner resource lease is active' };

test('a quarantined runner that other seats keep busy is left to the transport probe and its leak stop is skipped [C7]', async () => {
  const { db, home } = queueWith([4242]);
  try {
    let idleProbes = 0;
    const proof = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => { throw new Error('leak probe must not run'); }, idleProbe: async () => { idleProbes++; return unhealthy; }, token: 'token-1' });
    assert.equal(proof, unhealthy);
    assert.equal(idleProbes, 0, 'a busy runner is not asked to prove idle');
    const event = db.prepare("SELECT detail FROM runner_recovery_event WHERE kind = 'leak-stop-skipped'").get();
    assert.equal(JSON.parse(event.detail).busy, true);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a quarantined runner that does not answer its leak probe, or answers with an error, stays quarantined [C7]', async () => {
  const { db, home } = queueWith([4242]);
  try {
    const refused = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => ({ ok: false, stopped: [] }), idleProbe: async () => unhealthy, token: 'token-1' });
    assert.equal(refused, unhealthy);
    const thrown = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => { throw new Error('ssh lost'); }, idleProbe: async () => unhealthy, token: 'token-1' });
    assert.equal(thrown, unhealthy);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a quarantined runner with no holders still proves idle and writable after its leaked job is stopped [C7]', async () => {
  const { db, home } = queueWith([]);
  try {
    const idle = { healthy: true, idle: true, writable: true, step: 'idle proof', reason: 'no live runner process' };
    const proof = await healLeakedRunner(db, row, { host: HOST }, unhealthy,
      { leakProbe: async () => ({ ok: true, stopped: [777] }), idleProbe: async () => idle, token: 'token-1' });
    assert.equal(proof, idle);
    const notIdle = await healLeakedRunner(db, { ...row }, { host: HOST }, unhealthy,
      { leakProbe: async () => ({ ok: true, stopped: [] }), idleProbe: async () => unhealthy, token: 'token-1' });
    assert.equal(notIdle.healthy, false);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
