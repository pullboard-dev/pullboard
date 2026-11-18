/** gate.recaptureHandoff is a machine setting, off by default, listed with a description, and read by nothing yet [C7,#8989]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recaptureHandoffEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-recapture-handoff-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.recaptureHandoff, read through the real inventory with no boards registered. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.recaptureHandoff'));
}

test('config.io-recapture-handoff-setting.clause-1-gate-recapturehandoff-defaults: clause 1: gate.recaptureHandoff defaults to false in the inventory, reads on only for an exact true, and a non-boolean is refused [C7,#8989]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.equal(withSettings({}, recaptureHandoffEnabled), false);
  assert.equal(withSettings({ gate: { recaptureHandoff: true } }, recaptureHandoffEnabled), true);
  assert.throws(() => withSettings({ gate: { recaptureHandoff: 'yes' } }, recaptureHandoffEnabled), /gate\.recaptureHandoff/u);
});

test('config.io-recapture-handoff-setting.clause-2-gate-recapturehandoff-has-a: clause 2: gate.recaptureHandoff has a described row that pullboard settings prints [C7,#8989]', () => {
  const described = row({});
  assert.ok(described.label, 'the row carries a plain label');
  assert.match(described.description ?? JSON.stringify(described), /queued gate recapture/u);
});
