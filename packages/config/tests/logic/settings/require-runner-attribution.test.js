/** gate.requireRunnerAttribution is a boolean machine setting that is off until a person turns it on [C7,#4000]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Load machine settings from a private home holding the given settings, and restore the home afterwards. */
function loadWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-require-attribution-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: gate.requireRunnerAttribution loads as true or false and refuses anything else [C7]', () => {
  assert.equal(loadWith({ gate: { requireRunnerAttribution: true } }).gate.requireRunnerAttribution, true);
  assert.equal(loadWith({ gate: { requireRunnerAttribution: false } }).gate.requireRunnerAttribution, false);
  assert.throws(() => loadWith({ gate: { requireRunnerAttribution: 'yes' } }), error => error.code === 'BAD_MACHINE_SETTINGS');
});

test('clause 1: gate.requireRunnerAttribution is absent by default [C7]', () => {
  assert.equal(loadWith({ gate: {} }).gate.requireRunnerAttribution, undefined);
});
