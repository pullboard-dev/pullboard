/** machine.holdHeavyAboveLoad is a described default-off machine setting with an exact-true accessor [C7,#10139]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { heavyLocalHoldEnabled } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-heavy-hold-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for machine.holdHeavyAboveLoad. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'machine.holdHeavyAboveLoad'));
}

test('config.io-settings-heavy-hold.clause-1-machine-holdheavyaboveload-is-off: clause 1: machine.holdHeavyAboveLoad is false in the machine defaults and listed with a description [C7,#10139]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /local resource line/u);
});

test('config.io-settings-heavy-hold.clause-2-a-non-boolean-machine-holdheavyaboveload: clause 2: a non-boolean machine.holdHeavyAboveLoad is refused with BAD_MACHINE_SETTINGS [C7,#10139]', () => {
  for (const bad of ['yes', 1, null, {}]) {
    assert.throws(() => withSettings({ machine: { holdHeavyAboveLoad: bad } }, heavyLocalHoldEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /machine\.holdHeavyAboveLoad/u.test(error.message));
  }
});

test('config.io-settings-heavy-hold.clause-3-heavylocalholdenabled-is-true-for: clause 3: heavyLocalHoldEnabled() is true for an exact true only [C7,#10139]', () => {
  assert.equal(withSettings({}, heavyLocalHoldEnabled), false);
  assert.equal(withSettings({ machine: { holdHeavyAboveLoad: false } }, heavyLocalHoldEnabled), false);
  assert.equal(withSettings({ machine: { holdHeavyAboveLoad: true } }, heavyLocalHoldEnabled), true);
});
