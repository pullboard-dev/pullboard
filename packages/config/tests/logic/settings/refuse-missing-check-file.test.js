/** gate.refuseMissingCheckFile is off unless set exactly to true, and anything else is refused [C7,#3095]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { loadMachineSettings } from '../../../index.js';
import { refuseMissingCheckFile } from '../../../index.js';

/** Point the machine home at a private directory holding the given settings, and restore it afterwards. */
function withSettings(settings, work) {
  const { root: dir } = privateFixtureFiles('pullboard-missing-check-file-setting-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    if (settings) fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return work();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: the missing-check-file refusal is off until the machine setting is exactly true [C7,#3095]', () => {
  assert.equal(withSettings(null, refuseMissingCheckFile), false);
  assert.equal(withSettings({ gate: {} }, refuseMissingCheckFile), false);
  assert.equal(withSettings({ gate: { refuseMissingCheckFile: false } }, refuseMissingCheckFile), false);
  assert.equal(withSettings({ gate: { refuseMissingCheckFile: true } }, refuseMissingCheckFile), true);
});

test('clause 1: a non-boolean gate.refuseMissingCheckFile is a machine settings refusal [C7,#3095]', () => {
  for (const bad of ['true', 1, null]) {
    assert.throws(() => withSettings({ gate: { refuseMissingCheckFile: bad } }, loadMachineSettings), /BAD_MACHINE_SETTINGS.*refuseMissingCheckFile/u);
  }
});
