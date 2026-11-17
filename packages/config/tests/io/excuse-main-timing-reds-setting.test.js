/** gate.excuseMainTimingReds is a machine setting, off by default, listed with a description [C7,#9753]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { excuseMainTimingReds } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-excuse-main-timing-reds-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for gate.excuseMainTimingReds. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'gate.excuseMainTimingReds'));
}

test('clause 1: gate.excuseMainTimingReds is a described machine setting, off by default [C7,#9753]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /timing reds/u);
});

test('clause 2: excuseMainTimingReds() is true only for an exact true [C7,#9753]', () => {
  assert.equal(withSettings({}, excuseMainTimingReds), false);
  assert.equal(withSettings({ gate: { excuseMainTimingReds: false } }, excuseMainTimingReds), false);
  assert.equal(withSettings({ gate: { excuseMainTimingReds: true } }, excuseMainTimingReds), true);
});

test('clause 3: a non-boolean gate.excuseMainTimingReds is refused BAD_MACHINE_SETTINGS [C7,#9753]', () => {
  for (const bad of ['yes', 1, 'true']) {
    assert.throws(() => withSettings({ gate: { excuseMainTimingReds: bad } }, excuseMainTimingReds), (err) => err.code === 'BAD_MACHINE_SETTINGS' && /gate\.excuseMainTimingReds/u.test(err.message));
  }
});
