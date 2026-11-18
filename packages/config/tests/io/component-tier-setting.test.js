/** gate.componentTier is a machine setting, off by default, listed with a description [C7,#9786]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateComponentTier } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-component-tier-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.componentTier. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.componentTier'));
}

test('config.io-component-tier-setting.clause-1-gate-componenttier-is-a: clause 1: gate.componentTier is a described machine setting, off by default [C7,#9786]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /front doors/u);
});

test('config.io-component-tier-setting.clause-2-gatecomponenttier-is-true-only: clause 2: gateComponentTier() is true only for an exact true [C7,#9786]', () => {
  assert.equal(withSettings({}, gateComponentTier), false);
  assert.equal(withSettings({ gate: { componentTier: false } }, gateComponentTier), false);
  assert.equal(withSettings({ gate: { componentTier: true } }, gateComponentTier), true);
});

test('config.io-component-tier-setting.clause-3-a-non-boolean-gate: clause 3: a non-boolean gate.componentTier is refused BAD_MACHINE_SETTINGS [C7,#9786]', () => {
  for (const bad of ['yes', 1, 'true']) {
    assert.throws(() => withSettings({ gate: { componentTier: bad } }, gateComponentTier), (err) => err.code === 'BAD_MACHINE_SETTINGS' && /gate\.componentTier/u.test(err.message));
  }
});
