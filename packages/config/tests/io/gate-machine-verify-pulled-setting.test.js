/** @pullboard-test-input source-cell config */
/** gate.machineVerifyPulled is a machine setting, off by default, described, and refuses non-booleans [C7,#10250]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-machine-verify-pulled-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.machineVerifyPulled. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.machineVerifyPulled'));
}

test('config.io-gate-machine-verify-pulled-setting.clause-1-defaults-to-false: clause 1: gate.machineVerifyPulled is a described machine setting that defaults to false and accepts true and false [C7,#10250]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /clause command receipts/u);
  assert.equal(row({ gate: { machineVerifyPulled: true } }).value, true);
  assert.equal(row({ gate: { machineVerifyPulled: false } }).value, false);
});

test('config.io-gate-machine-verify-pulled-setting.clause-1-refuses-non-boolean: clause 1: gate.machineVerifyPulled refuses any other value with BAD_MACHINE_SETTINGS [C7,#10250]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => row({ gate: { machineVerifyPulled: bad } }), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.machineVerifyPulled/u.test(error.message));
  }
});
