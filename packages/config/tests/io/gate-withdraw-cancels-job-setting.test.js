/** @pullboard-test-input source-cell config */
/** gate.withdrawCancelsJob is a machine setting, off by default, described, and on only for an exact true [C7,#3860]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { withdrawCancelsJob } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-withdraw-cancels-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.withdrawCancelsJob. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.withdrawCancelsJob'));
}

test('config.io-gate-withdraw-cancels-job-setting.clause-1-gate-withdrawcancelsjob: clause 1: gate.withdrawCancelsJob defaults to false, is described, and withdrawCancelsJob() is true only on an exact true [C7,#3860]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /live gate job/u);
  assert.equal(withSettings({}, withdrawCancelsJob), false);
  assert.equal(withSettings({ gate: { withdrawCancelsJob: true } }, withdrawCancelsJob), true);
  assert.equal(withSettings({ gate: { withdrawCancelsJob: false } }, withdrawCancelsJob), false);
});

test('config.io-gate-withdraw-cancels-job-setting.clause-2-a-non-boolean-gate: clause 2: a non-boolean gate.withdrawCancelsJob refuses with BAD_MACHINE_SETTINGS [C7,#3860]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ gate: { withdrawCancelsJob: bad } }, withdrawCancelsJob), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.withdrawCancelsJob/u.test(error.message));
  }
});
