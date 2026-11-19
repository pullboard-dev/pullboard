/** landing.parallelGates is a machine setting, off by default, listed with a description [C7,#9747]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parallelGatesEnabled } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-parallel-gates-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.parallelGates. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.parallelGates'));
}

test('config.io-settings-parallel-gates-setting.clause-1-landing-parallelgates-is-a: clause 1: landing.parallelGates is a described machine setting whose default is off [C7,#9747]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /second batch/u);
});

test('config.io-settings-parallel-gates-setting.clause-2-reading-landing-parallelgates: clause 2: reading landing.parallelGates through the settings reader returns false when unset, true only for an exact true [C7,#9747]', () => {
  assert.equal(withSettings({}, parallelGatesEnabled), false);
  assert.equal(withSettings({ landing: { parallelGates: true } }, parallelGatesEnabled), true);
  assert.throws(() => withSettings({ landing: { parallelGates: 'yes' } }, parallelGatesEnabled), /landing\.parallelGates/u);
});
