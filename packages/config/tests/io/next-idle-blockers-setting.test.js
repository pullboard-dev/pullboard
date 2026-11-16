/** @pullboard-test-input source-cell config */
/** next.idleBlockers is a machine setting, off by default, listed with a description, and read by nothing yet [C7,#2958]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-idle-blockers-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for next.idleBlockers, read through the real inventory with no boards registered. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'next.idleBlockers'));
}

test('clause 1: next.idleBlockers is in the settings inventory with default false [C7,#2958]', () => {
  const unset = row({});
  assert.ok(unset, 'the inventory lists next.idleBlockers');
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
});

test('clause 2: next.idleBlockers has a described row that pullboard settings prints [C7,#2958]', () => {
  const described = row({});
  assert.ok(described.label, 'the row carries a plain label');
  assert.match(described.description ?? JSON.stringify(described), /waiting items/u);
});
