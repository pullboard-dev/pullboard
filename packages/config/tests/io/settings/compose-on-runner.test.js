/** submit.composeOnRunner is a machine setting, on by default, described, and off only for an exact false [C7,#10755,#11423]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitComposeOnRunner } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-compose-on-runner-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for submit.composeOnRunner. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'submit.composeOnRunner'));
}

test('config.io-settings-compose-on-runner.clause-1-default-false: clause 1: submit.composeOnRunner defaults to true and is listed with a description [C7,#10755]', () => {
  const unset = row({});
  assert.equal(unset.default, true);
  assert.equal(unset.value, true);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /queued gate job composes/u);
  assert.match(unset.description ?? JSON.stringify(unset), /On by default/u);
});

test('config.io-settings-compose-on-runner.clause-2-non-boolean-refused: clause 2: a non-boolean submit.composeOnRunner refuses with BAD_MACHINE_SETTINGS naming the key [C7,#10755]', () => {
  for (const bad of ['yes', 1, 'true', null]) {
    assert.throws(() => withSettings({ submit: { composeOnRunner: bad } }, submitComposeOnRunner), error => error.code === 'BAD_MACHINE_SETTINGS' && /submit\.composeOnRunner/u.test(error.message));
  }
});

test('config.io-settings-compose-on-runner.clause-3-accessor: clause 3: submitComposeOnRunner() is true with no setting and false only on an exact false [C7,#10755]', () => {
  assert.equal(withSettings({}, submitComposeOnRunner), true);
  assert.equal(withSettings({ submit: { composeOnRunner: false } }, submitComposeOnRunner), false);
  assert.equal(withSettings({ submit: { composeOnRunner: true } }, submitComposeOnRunner), true);
});

test('config.io-settings-compose-on-runner.default-on-from-11423: the machine defaults list submit.composeOnRunner as true and the accessor reads true with no setting, false for an exact false [C7,#11423]', () => {
  assert.equal(withSettings({}, submitComposeOnRunner), true);
  assert.equal(withSettings({ submit: { composeOnRunner: false } }, submitComposeOnRunner), false);
  assert.equal(withSettings({ submit: { composeOnRunner: true } }, submitComposeOnRunner), true);
});
