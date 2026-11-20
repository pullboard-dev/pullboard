/** landing.exactTreeCheck is a described repo setting, off unless the repo sets it: RFC 0011 ET5, narrowed and approved 17 Nov 2026 [V16,V36]. */
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

const BOARD_ID = 'a'.repeat(32);

/** A real git repository with a registered (empty) board and the given pullboard.json, read through the real inventory; the machine home is private and empty. */
function repoRows(t, config, key = 'landing.exactTreeCheck') {
  const { root } = fixtureCommittedGraph('pullboard-exact-tree-check-');
  const machine = privateFixtureFiles('pullboard-exact-tree-machine-');
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

test('config.settings-inventory.exact-tree-check-declared: clause 1: landing.exactTreeCheck is a repo setting with default false and a one-line description [V16,V36]', t => {
  const rows = repoRows(t, null);
  assert.equal(rows.length, 1, 'the inventory lists the setting once');
  const [row] = rows;
  assert.equal(row.scope, 'repo');
  assert.equal(row.default, false);
  assert.ok(row.label, 'the row carries a plain label');
  assert.ok(row.description && !row.description.includes('\n'), 'the description is one line');
});

test('config.settings-inventory.exact-tree-check-listed-off: clause 2: pullboard settings lists landing.exactTreeCheck as off on a repo that does not set it, and on only when the repo sets true [V16,V36]', t => {
  const [unset] = repoRows(t, null);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  const [on] = repoRows(t, { landing: { exactTreeCheck: true } });
  assert.equal(on.value, true);
  assert.equal(on.origin, 'configured');
  const [bad] = repoRows(t, { landing: { exactTreeCheck: 'yes' } });
  assert.ok(bad.error, 'a non-boolean value is reported as an error on the row, never read as on');
});

test('config.settings-inventory.sprint-bar-tests-declared: clause 1: landing.sprintBarTests is a repo setting with default false and a one-line description, on only when the repo sets true, and an error when it is not a boolean [C7]', t => {
  const [unset] = repoRows(t, null, 'landing.sprintBarTests');
  assert.equal(unset.scope, 'repo');
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label && unset.description && !unset.description.includes('\n'), 'a plain label and a one-line description');
  const [on] = repoRows(t, { landing: { sprintBarTests: true } }, 'landing.sprintBarTests');
  assert.equal(on.value, true);
  assert.equal(on.origin, 'configured');
  const [bad] = repoRows(t, { landing: { sprintBarTests: 'yes' } }, 'landing.sprintBarTests');
  assert.ok(bad.error, 'a non-boolean value is reported as an error on the row, never read as on');
});

test('config.settings-inventory.review-folder-declared: clause 1: verify.reviewFolder is a repo setting with default true and a plain label and a one-line description [C7]', t => {
  const [unset] = repoRows(t, null, 'verify.reviewFolder');
  assert.equal(unset.scope, 'repo');
  assert.equal(unset.default, true);
  assert.equal(unset.value, true);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label && unset.description && !unset.description.includes('\n'), 'a plain label and a one-line description');
});

test('config.settings-inventory.review-folder-listed-off: clause 2: pullboard settings lists verify.reviewFolder on for a repo that does not set it, off only when the repo sets false, and an error row for a non-boolean [C7]', t => {
  const [unset] = repoRows(t, null, 'verify.reviewFolder');
  assert.equal(unset.value, true);
  assert.equal(unset.origin, 'default');
  const [off] = repoRows(t, { verify: { reviewFolder: false } }, 'verify.reviewFolder');
  assert.equal(off.value, false);
  assert.equal(off.origin, 'configured');
  const [bad] = repoRows(t, { verify: { reviewFolder: 'yes' } }, 'verify.reviewFolder');
  assert.ok(bad.error, 'a non-boolean value is reported as an error on the row, never read as on');
});

test('config.settings-inventory.review-folder-default-on: clause 1: verify.reviewFolder defaults to true on a repo with no verify setting [C7,#11458]', t => {
  const [unset] = repoRows(t, null, 'verify.reviewFolder');
  assert.equal(unset.default, true);
  assert.equal(unset.value, true);
  assert.equal(unset.origin, 'default');
});

test('config.settings-inventory.review-folder-config-false-off: clause 2: a project config with verify.reviewFolder false still turns it off, and the description says on by default [C7,#11458]', t => {
  const [off] = repoRows(t, { verify: { reviewFolder: false } }, 'verify.reviewFolder');
  assert.equal(off.value, false);
  assert.equal(off.origin, 'configured');
  assert.match(off.description, /on by default/i);
});

test('config.settings-inventory.unrelated-trunk-moves-off-by-default: clause 3: verify.unrelatedTrunkMoves is a described setting with default false, off on a repo that does not set it, and on only when the repo sets true [C7,#2981]', t => {
  const [unset] = repoRows(t, null, 'verify.unrelatedTrunkMoves');
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label && unset.description && !unset.description.includes('\n'), 'a plain label and a one-line description');
  const [on] = repoRows(t, { verify: { unrelatedTrunkMoves: true } }, 'verify.unrelatedTrunkMoves');
  assert.equal(on.value, true);
  assert.equal(on.origin, 'configured');
});
