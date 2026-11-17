/** landing.cargoFailures is a described machine setting, off by default, and only an exact true turns it on [C7,#10384]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingCargoFailures } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-cargo-failures-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The inventory row for landing.cargoFailures under the given settings. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.cargoFailures'));
}

test('config.io-settings-landing-cargo-failures.clause-1-landing-cargofailures-is-a: clause 1: landing.cargoFailures is a described machine setting, default false, and only an exact true turns it on [C7,#10384]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.equal(withSettings({}, landingCargoFailures), false);
  assert.equal(withSettings({ landing: { cargoFailures: true } }, landingCargoFailures), true);
  assert.equal(withSettings({ landing: { cargoFailures: false } }, landingCargoFailures), false);
});

test('config.io-settings-landing-cargo-failures.clause-2-a-non-boolean-landing-cargofailures: clause 2: a non-boolean landing.cargoFailures is refused with BAD_MACHINE_SETTINGS naming the key [C7,#10384]', () => {
  for (const bad of ['yes', 1, null, 'true']) {
    assert.throws(() => withSettings({ landing: { cargoFailures: bad } }, landingCargoFailures), error => error.code === 'BAD_MACHINE_SETTINGS' && /landing\.cargoFailures/u.test(error.message));
  }
});
