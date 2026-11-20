/** runners.jobWorkerFactor is a described machine setting, default 2, a number from 1 to 4 only [C7,#11837]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Loads the machine settings from a private machine home holding the given settings, restoring the home afterwards. */
function loadWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-job-worker-factor-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-job-worker-factor.clause-1-described-default-two: clause 1: runners.jobWorkerFactor holds 2 in MACHINE_DEFAULTS and is described in the Runners group [C7,#11837]', () => {
  assert.equal(MACHINE_DEFAULTS['runners.jobWorkerFactor'], 2);
  const row = describeSetting('runners.jobWorkerFactor');
  assert.ok(row, 'runners.jobWorkerFactor has a description row');
  assert.equal(row.group, 'Runners');
});

test('config.io-settings-job-worker-factor.clause-2-accepts-one-to-four: clause 2: runners.jobWorkerFactor accepts numbers from 1 to 4 [C7,#11837]', () => {
  for (const good of [1, 2, 3, 4]) assert.equal(loadWith({ 'runners.jobWorkerFactor': good })['runners.jobWorkerFactor'], good);
});

test('config.io-settings-job-worker-factor.clause-2-refuses-other-values: clause 2: a runners.jobWorkerFactor that is not a number from 1 to 4 is refused BAD_MACHINE_SETTINGS [C7,#11837]', () => {
  for (const bad of [0, 5, -1, '2', true, null, NaN]) {
    assert.throws(() => loadWith({ 'runners.jobWorkerFactor': bad }), (error) => error.code === 'BAD_MACHINE_SETTINGS' && /runners\.jobWorkerFactor/u.test(error.message));
  }
});
