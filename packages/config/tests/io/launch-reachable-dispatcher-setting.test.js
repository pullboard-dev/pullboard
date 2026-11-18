/** @pullboard-test-input source-cell config */
/** launch.reachableDispatcher is a machine setting, off by default, described, and on only for an exact true [C7,#10243]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { reachableDispatcherOn } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-reachable-dispatcher-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for launch.reachableDispatcher. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'launch.reachableDispatcher'));
}

test('config.io-launch-reachable-dispatcher-setting.clause-1-default-off: clause 1: launch.reachableDispatcher defaults to false, is described, and reachableDispatcherOn() is true only on an exact true [C7,#10243]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /launchd job/u);
  assert.equal(withSettings({}, reachableDispatcherOn), false);
  assert.equal(withSettings({ launch: { reachableDispatcher: true } }, reachableDispatcherOn), true);
  assert.equal(withSettings({ launch: { reachableDispatcher: false } }, reachableDispatcherOn), false);
});

test('config.io-launch-reachable-dispatcher-setting.clause-1-refuses-non-boolean: clause 1: a non-boolean launch.reachableDispatcher refuses with BAD_MACHINE_SETTINGS [C7,#10243]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ launch: { reachableDispatcher: bad } }, reachableDispatcherOn), error => error.code === 'BAD_MACHINE_SETTINGS' && /launch\.reachableDispatcher/u.test(error.message));
  }
});
