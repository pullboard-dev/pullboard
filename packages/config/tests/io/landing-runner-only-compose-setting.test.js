/** @pullboard-test-input source-cell config */
/** landing.runnerOnlyCompose is a machine setting, off by default, described, and on only for an exact true [C7,#10245]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runnerOnlyCompose } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-runner-only-compose-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.runnerOnlyCompose. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.runnerOnlyCompose'));
}

test('config.io-landing-runner-only-compose-setting.clause-1-landing-runneronlycompose-defaults: clause 1: landing.runnerOnlyCompose defaults to false, is described, and accepts true and false [C7,#10245]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /runner cannot compose/u);
  assert.equal(withSettings({}, runnerOnlyCompose), false);
  assert.equal(withSettings({ landing: { runnerOnlyCompose: true } }, runnerOnlyCompose), true);
  assert.equal(withSettings({ landing: { runnerOnlyCompose: false } }, runnerOnlyCompose), false);
});

test('config.io-landing-runner-only-compose-setting.clause-1-any-other-value-refuses: clause 1: any other landing.runnerOnlyCompose value refuses with BAD_MACHINE_SETTINGS [C7,#10245]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ landing: { runnerOnlyCompose: bad } }, runnerOnlyCompose), error => error.code === 'BAD_MACHINE_SETTINGS' && /landing\.runnerOnlyCompose/u.test(error.message));
  }
});
