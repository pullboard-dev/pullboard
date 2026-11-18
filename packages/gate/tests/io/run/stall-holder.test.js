/** @pullboard-test-loads packages/resources/src/io/liveness.js */
/** A slot holder with no live process is released, logged and named in the slot log [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '../../../../..');

test('gate.io-run-stall-holder.a-slot-holder-with-no-live: clause 1: a slot holder with no live process is released, and the slot log names who held it and why [C7]', async t => {
  const { reclaimHolders } = await import(pathToFileURL(join(REPO, 'packages/resources/src/io/liveness.js')).href);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE holder(token TEXT PRIMARY KEY, name TEXT, pid INTEGER, started TEXT, item TEXT, heartbeat INTEGER, terminating INTEGER DEFAULT 0, request TEXT DEFAULT '', relaunched INTEGER DEFAULT 0, agent TEXT DEFAULT '', repo TEXT DEFAULT '', kind TEXT DEFAULT '');
    CREATE TABLE liveness_event(at TEXT, kind TEXT, name TEXT, item TEXT, pid INTEGER, detail TEXT)`);
  db.prepare('INSERT INTO holder(token, name, pid, started, item, heartbeat, agent, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('t', 'gate', 4242, 'Mon Nov  4 01:00:00 2026', '6385', Date.now(), 'core-9000', 'gate');
  reclaimHolders(db, Date.now(), { alive: () => false, processIdentity: () => assert.fail('a dead PID needs no identity') });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder').get().n, 0, 'the dead holder no longer holds the slot');
  const freed = db.prepare("SELECT name, item, pid, detail FROM liveness_event WHERE kind = 'freed'").all();
  assert.equal(freed.length, 1, 'one freed entry is logged');
  assert.equal(freed[0].pid, 4242);
  assert.equal(freed[0].item, '6385');
  assert.match(freed[0].detail, /released the gate slot held by core-9000 \(pid 4242, gate\): process gone/u, 'the log names the holder');
});
