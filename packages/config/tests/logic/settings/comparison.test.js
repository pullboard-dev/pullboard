/** gate.mainComparison is on-red unless set exactly to off, and anything else is refused [C7,#5565]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { mainComparisonMode } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Point the machine home at a private directory holding the given settings, and restore it afterwards. */
function withSettings(settings, work) {
  const { root: dir } = privateFixtureFiles('pullboard-main-comparison-setting-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    if (settings) fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return work();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('the main comparison mode is on-red until the machine setting is exactly off [C7,#5565]', () => {
  assert.equal(withSettings(null, mainComparisonMode), 'on-red');
  assert.equal(withSettings({ gate: {} }, mainComparisonMode), 'on-red');
  assert.equal(withSettings({ gate: { mainComparison: 'on-red' } }, mainComparisonMode), 'on-red');
  assert.equal(withSettings({ gate: { mainComparison: 'off' } }, mainComparisonMode), 'off');
});

test('any other main comparison value is a machine settings refusal naming the two choices [C7,#5565]', () => {
  for (const bad of ['Off', 'never', true, 0, null]) {
    assert.throws(() => withSettings({ gate: { mainComparison: bad } }, loadMachineSettings), /BAD_MACHINE_SETTINGS.*"on-red" or "off"/u, `${JSON.stringify(bad)} is refused`);
  }
});
