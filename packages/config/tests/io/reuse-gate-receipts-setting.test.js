/** landing.reuseGateReceipts is a machine setting, off by default, listed with a description [C7,#9243]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reuseGateReceiptsEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-reuse-gate-receipts-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.reuseGateReceipts. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.reuseGateReceipts'));
}

test('config.io-reuse-gate-receipts-setting.clause-1-landing-reusegatereceipts-is-a: clause 1: landing.reuseGateReceipts is a described setting, off by default, on only for an exact true [C7,#9243]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /gate results/u);
  assert.equal(withSettings({}, reuseGateReceiptsEnabled), false);
  assert.equal(withSettings({ landing: { reuseGateReceipts: true } }, reuseGateReceiptsEnabled), true);
  assert.throws(() => withSettings({ landing: { reuseGateReceipts: 'yes' } }, reuseGateReceiptsEnabled), /landing\.reuseGateReceipts/u);
});
