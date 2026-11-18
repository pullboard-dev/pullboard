/** landing.reofferTrunkBusy is a machine setting, off by default, listed with a description [C7,#9102]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reofferTrunkBusyEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-reoffer-trunk-busy-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.reofferTrunkBusy, read through the real inventory with no boards registered. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.reofferTrunkBusy'));
}

test('config.io-reoffer-trunk-busy-setting.clause-3-landing-reoffertrunkbusy-is-a: clause 3: landing.reofferTrunkBusy is a described setting, off by default, on only for an exact true [C7,#9102]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /trunk moved/u);
  assert.equal(withSettings({}, reofferTrunkBusyEnabled), false);
  assert.equal(withSettings({ landing: { reofferTrunkBusy: true } }, reofferTrunkBusyEnabled), true);
  assert.throws(() => withSettings({ landing: { reofferTrunkBusy: 'yes' } }, reofferTrunkBusyEnabled), /landing\.reofferTrunkBusy/u);
});
