/** Controller registration refuses each distinct loss of native lease custody [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { controllerRegistrationPorts } from '../../../../src/io/controller/custody.js';

test('resources.diagnostics.controller-registration-identifies-the-failed-holder: controller registration identifies the failed holder predicate [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'queue.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE holder (token TEXT PRIMARY KEY, pid INTEGER, started TEXT, controller_identity TEXT NOT NULL DEFAULT '')");
  t.after(() => db.close());
  const ports = controllerRegistrationPorts({ pool: () => file, open: () => new DatabaseSync(file),
    update: (_db, action) => action(), processStarted: () => 'current-start' });
  const owner = { pool: file, token: 'test-lease' };
  const identity = { controllerPid: process.pid, started: 'current-start', holderStarted: 'holder-start' };
  const register = () => ports.registerController(owner, process.pid, identity);
  assert.throws(register, { code: 'RESOURCE_LEASE_LOST', message: /holder is missing/u });
  db.prepare('INSERT INTO holder VALUES (?, ?, ?, ?)').run(owner.token, process.pid + 1, 'holder-start', '');
  assert.throws(register, { code: 'RESOURCE_LEASE_LOST', message: /holder PID/u });
  db.prepare('UPDATE holder SET pid = ?, started = ?').run(process.pid, 'different-start');
  assert.throws(register, { code: 'RESOURCE_LEASE_LOST', message: /holder start time/u });
  db.prepare('UPDATE holder SET started = ?, controller_identity = ?').run('holder-start', '{}');
  assert.throws(register, { code: 'RESOURCE_LEASE_LOST', message: /already has a bound controller/u });
  db.prepare("UPDATE holder SET controller_identity = ''").run();
  register();
  assert.equal(db.prepare('SELECT controller_identity FROM holder').get().controller_identity, JSON.stringify(identity));
});
