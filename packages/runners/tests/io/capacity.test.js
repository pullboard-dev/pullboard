/** @pullboard-test-input source-cell packages/runners */
/** Capacity reads retain real private SQLite state and unknown evidence without admission side effects [C7,O5]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readRunnerCapacities } from '../../index.js';
import { runnerUtilization } from '../../index.js';
import { loadMachineSettings } from '../../../config/index.js';

/** Isolate only this fixture's machine path; every database and settings file is genuinely read from disk. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-capacity-read-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1,
    runners: [{ host: 'fixture-host', slots: 3, browser: 1 }] }));
  return root;
}

test('runners.capacity.missing-resource-pool-retains-configured-local: missing resource pool retains configured local and remote runners with unknown utilization [C7]', t => {
  const root = fixture(t), rows = readRunnerCapacities();
  assert.equal(rows.length, 2); assert.equal(rows[0].slots.current, 2);
  assert.equal(rows[1].id, 'fixture-host'); assert.equal(rows[1].slots.current, 3);
  assert.equal(rows[1].capabilities.os, null); assert.equal(rows[0].capabilities.gui, null);
  const result = runnerUtilization(rows, [], { from: '2026-10-27T00:00:00.000Z', to: '2026-10-27T01:00:00.000Z' });
  for (const row of result.runners) { assert.equal(row.peakBusyShare, null); assert.equal(row.unknownWindows, 12); }
  assert.deepEqual(result.warnings, []);
  assert.equal(existsSync(join(root, 'resources.sqlite')), false, 'read never creates a missing admission pool');
});

test('runners.capacity.old-pool-capacities-and-draining-identities: old pool capacities and draining identities are read without migrations or deleting expired holders [C7]', t => {
  const root = fixture(t), file = join(root, 'resources.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE resource(name TEXT PRIMARY KEY,capacity INTEGER); INSERT INTO resource VALUES('gate',4),('browser',1); CREATE TABLE holder(token TEXT PRIMARY KEY,name TEXT,pid INTEGER,heartbeat INTEGER); CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT);");
  db.prepare('INSERT INTO holder VALUES(?,?,?,?)').run('expired-observation', 'runner:retiring-host', 2147483647, 0);
  db.prepare('INSERT INTO runner_draining VALUES(?,?)').run('retiring-host', JSON.stringify({ host: 'retiring-host', slots: 2, browser: 0 }));
  const schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(); db.close();
  const bytes = readFileSync(file), rows = readRunnerCapacities();
  assert.equal(rows[0].slots.current, 4, 'persisted local capacity precedes configuration');
  assert.equal(rows.find(row => row.id === 'fixture-host').slots.current, 3);
  assert.equal(rows.find(row => row.id === 'retiring-host').draining, true);
  assert.equal(rows.find(row => row.id === 'retiring-host').active, 1, 'observed holder is not silently pruned');
  assert.deepEqual(readFileSync(file), bytes, 'read-only observation changes no database bytes');
  const again = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual(again.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM holder').get().n, 1); }
  finally { again.close(); }
  assert.deepEqual(readRunnerCapacities(), rows);
});

test('runners.capacity.unrelated-invalid-settings-and-corrupt-existing: unrelated invalid settings and corrupt existing pools remain failures instead of fabricated empty rows [C7]', t => {
  const root = fixture(t), settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ gateSlots: 2, browserSlots: 1, health: { sentinel: 'yes' } }));
  assert.throws(() => loadMachineSettings(), error => error.code === 'BAD_MACHINE_SETTINGS');
  assert.throws(() => readRunnerCapacities(), error => error.code === 'BAD_MACHINE_SETTINGS');
  writeFileSync(settings, JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  writeFileSync(join(root, 'resources.sqlite'), 'not a SQLite database');
  assert.throws(() => readRunnerCapacities());
});
