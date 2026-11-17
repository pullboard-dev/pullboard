/** landing.strictFullSuite is a machine setting, off by default, listed with a description [M2,#9323]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { strictFullSuiteEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-strict-full-suite-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.strictFullSuite, read through the real inventory with no boards registered. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.strictFullSuite'));
}

test('config.io-strict-full-suite-setting.clause-1-landing-strictfullsuite-is: clause 1: landing.strictFullSuite is false in the defaults and has a description [M2,#9323]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /full suite/u);
  assert.equal(withSettings({}, strictFullSuiteEnabled), false);
});

test('config.io-strict-full-suite-setting.clause-2-a-settings-read-returns-true: clause 2: a settings read returns true once landing.strictFullSuite is set [M2,#9323]', () => {
  assert.equal(withSettings({ landing: { strictFullSuite: true } }, strictFullSuiteEnabled), true);
  assert.equal(withSettings({ landing: { strictFullSuite: false } }, strictFullSuiteEnabled), false);
  assert.equal(row({ landing: { strictFullSuite: true } }).value, true);
});

test('config.io-strict-full-suite-setting.clause-3-a-non-boolean-landing: clause 3: a non-boolean landing.strictFullSuite is refused naming the key [M2,#9323]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ landing: { strictFullSuite: bad } }, strictFullSuiteEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /landing\.strictFullSuite/u.test(error.message));
  }
});
