/** gate.fencedHop is on by default: unset machine settings read true, and a machine that sets it false reads false [C7,#8327]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fencedHopEnabled } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Whether gate.fencedHop is on for a private machine home holding the given settings, restoring the home afterwards. */
function enabledWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-fenced-hop-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return fencedHopEnabled();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: gate.fencedHop reads true when the machine settings leave it unset [C7,#8327]', () => {
  assert.equal(enabledWith({ gate: { runnerDispatch: 'pull' } }), true);
  assert.equal(enabledWith({}), true);
});

test('clause 2: gate.fencedHop reads false when the machine settings set it false [C7,#8327]', () => {
  assert.equal(enabledWith({ gate: { fencedHop: false } }), false);
});
