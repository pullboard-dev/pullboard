/** jobs.expediteMax is a described repo setting whose default is 3, read through the same inventory read as claims.itemsInGateMax [C7,#11809]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const BOARD_ID = 'b'.repeat(32);

/** A real git repository with a registered (empty) board and the given pullboard.json, read through the real inventory; the machine home is private and empty. */
function repoRow(t, config, key = 'jobs.expediteMax') {
  const { root } = fixtureCommittedGraph('pullboard-expedite-max-');
  const machine = privateFixtureFiles('pullboard-expedite-max-machine-');
  const savedHome = process.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (savedHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(machine.root, { recursive: true, force: true });
  });
  process.env.PULLBOARD_MACHINE_HOME = join(machine.root, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, {});
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'));
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('board_id', BOARD_ID);
  db.close();
  fixtureProjectPolicy(root, { config: config ?? {} });
  const { settings } = settingsInventory([{ root }], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0, performanceCores: () => 2 });
  return settings.filter(row => row.key === key);
}

test('config.settings-expedite-max.default-three: clause 1: jobs.expediteMax is a described repo setting listed once with default 3, read as 3 when unset through the same read as claims.itemsInGateMax [C7,#11809]', t => {
  const unsetRows = repoRow(t, null);
  assert.equal(unsetRows.length, 1, 'the inventory lists the setting once');
  const [unset] = unsetRows;
  assert.equal(unset.scope, 'repo');
  assert.equal(unset.default, 3);
  assert.equal(unset.value, 3);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label && unset.description && !unset.description.includes('\n'), 'a plain label and a one-line description');
  const [neighbour] = repoRow(t, null, 'claims.itemsInGateMax');
  assert.equal(neighbour.value, unset.value, 'the neighbouring cap resolves through the same read to the same default');
  assert.equal(neighbour.origin, unset.origin);
});

test('config.settings-expedite-max.configured-value: clause 3: a jobs.expediteMax in the repo policy is kept by the config read and resolves, not stripped as an unknown key [C7,#11809]', t => {
  const [row] = repoRow(t, { jobs: { expediteMax: 5 } });
  assert.equal(row.value, 5, 'the configured number resolves');
  assert.notEqual(row.origin, 'default');
  assert.equal(row.default, 3);
});
