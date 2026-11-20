/** gate.gateAgedMinutes is a described machine setting, 5 by default, whole minutes 1 to 1440 only [C7,#11874]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateAgedMs } from '../../../index.js';
import { loadMachineSettings } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Runs `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-gate-aged-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    if (settings) fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-gate-aged.default-and-set-value: clause 1: gateAgedMs returns 300000 with no setting and 120000 when gate.gateAgedMinutes is 2 [C7,#11874]', () => {
  assert.equal(withSettings(null, gateAgedMs), 300000);
  assert.equal(withSettings({ gate: { gateAgedMinutes: 2 } }, gateAgedMs), 120000);
});

test('config.io-settings-gate-aged.refuses-bad-values: clause 2: gate.gateAgedMinutes of 0 or 1.5 is refused BAD_MACHINE_SETTINGS naming the setting [C7,#11874]', () => {
  for (const bad of [0, 1.5]) {
    assert.throws(() => withSettings({ gate: { gateAgedMinutes: bad } }, loadMachineSettings),
      (error) => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.gateAgedMinutes/u.test(error.message));
  }
});
