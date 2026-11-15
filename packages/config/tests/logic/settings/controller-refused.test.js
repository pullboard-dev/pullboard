/** gate.runnerDispatch controller is refused with a next step once gate.refuseController is on, and stays readable while it is off [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../apps/cli/tests/fixtures/testkit.js';

/** Load machine settings from a private home holding the given settings, and restore the home afterwards. */
function loadWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-controller-refused-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: with the refusal on, controller is refused naming the step to pull; pull and off stay valid [P7]', () => {
  assert.throws(() => loadWith({ gate: { runnerDispatch: 'controller', refuseController: true } }),
    error => error.code === 'BAD_MACHINE_SETTINGS' && /next: run pullboard settings gate\.runnerDispatch pull/u.test(error.message));
  assert.equal(loadWith({ gate: { runnerDispatch: 'pull', refuseController: true } }).gate.runnerDispatch, 'pull');
  assert.equal(loadWith({ gate: { refuseController: true } }).gate.refuseController, true);
  assert.throws(() => loadWith({ gate: { refuseController: 'yes' } }), error => error.code === 'BAD_MACHINE_SETTINGS');
});

test('clause 1: the refusal is off by default, so a machine still on controller loads as before [P7]', () => {
  assert.equal(loadWith({ gate: { runnerDispatch: 'controller' } }).gate.runnerDispatch, 'controller');
});
