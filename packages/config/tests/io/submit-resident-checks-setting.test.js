/** @pullboard-test-input source-cell config */
/** submit.residentChecks is a machine setting, off by default, described, and on only for an exact true [C7,#10275]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { residentChecks } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-resident-checks-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for submit.residentChecks. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'submit.residentChecks'));
}

test('config.io-submit-resident-checks-setting.clause-1-submit-residentchecks-defaults-to: clause 1: submit.residentChecks is a described setting that defaults to false and accepts true and false [C7,#10275]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /resident/u);
  assert.equal(withSettings({}, residentChecks), false);
  assert.equal(withSettings({ submit: { residentChecks: true } }, residentChecks), true);
  assert.equal(withSettings({ submit: { residentChecks: false } }, residentChecks), false);
});

test('config.io-submit-resident-checks-setting.clause-1-any-other-value-is-refused: clause 1: any value other than true or false is refused with BAD_MACHINE_SETTINGS [C7,#10275]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ submit: { residentChecks: bad } }, residentChecks), error => error.code === 'BAD_MACHINE_SETTINGS' && /submit\.residentChecks/u.test(error.message));
  }
});
