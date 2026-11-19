/** gate.retryNewRedsOnce is off unless the machine settings turn it on, must be a boolean, and is described with its default [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { retryNewRedsOnceEnabled } from '../../../index.js';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';
import { SETTING_DESCRIPTIONS } from '../../../src/io/settings/descriptions.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Whether gate.retryNewRedsOnce is on for a private machine home holding the given settings, restoring the home afterwards. */
function enabledWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-retry-new-reds-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return retryNewRedsOnceEnabled();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-retry-new-reds-once.reads-false-unset-and-true-when-set: clause 1: gate.retryNewRedsOnce reads false unset and false, and true when set [C7]', () => {
  assert.equal(enabledWith({}), false);
  assert.equal(enabledWith({ gate: { retryNewRedsOnce: false } }), false);
  assert.equal(enabledWith({ gate: { retryNewRedsOnce: true } }), true);
});

test('config.io-settings-retry-new-reds-once.non-boolean-is-refused: clause 1: a non-boolean gate.retryNewRedsOnce is refused naming the setting [C7]', () => {
  assert.throws(() => enabledWith({ gate: { retryNewRedsOnce: 'yes' } }), /gate\.retryNewRedsOnce/u);
});

test('config.io-settings-retry-new-reds-once.is-described-and-off-by-default: clause 2: gate.retryNewRedsOnce is off by default and has a description row [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.retryNewRedsOnce'], false);
  assert.ok(SETTING_DESCRIPTIONS['gate.retryNewRedsOnce'], 'the setting has a description');
});
