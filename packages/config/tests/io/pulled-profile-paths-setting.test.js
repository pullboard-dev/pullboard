/** @pullboard-test-input source-cell config */
/** gate.pulledProfilePaths is a machine setting, off by default, listed with a description, and read by nothing yet [C7,#7301]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-pulled-profile-paths-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.pulledProfilePaths, read through the real inventory with no boards registered. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.pulledProfilePaths'));
}

test('config.io-pulled-profile-paths-setting.clause-1-gate-pulledprofilepaths-is-in: clause 1: gate.pulledProfilePaths is in the settings inventory with default false [C7,#7301]', () => {
  const unset = row({});
  assert.ok(unset, 'the inventory lists gate.pulledProfilePaths');
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
});

test('config.io-pulled-profile-paths-setting.clause-2-gate-pulledprofilepaths-has-a: clause 2: gate.pulledProfilePaths has a described row that pullboard settings prints [C7,#7301]', () => {
  const described = row({});
  assert.ok(described.label, 'the row carries a plain label');
  assert.match(described.description ?? JSON.stringify(described), /phase timing profile/u);
});
