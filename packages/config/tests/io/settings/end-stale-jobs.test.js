/** gate.endStaleJobs is off unless the machine settings turn it on, and must be a boolean [C7,#8816]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { endStaleJobsEnabled } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Whether gate.endStaleJobs is on for a private machine home holding the given settings, restoring the home afterwards. */
function enabledWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-end-stale-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return endStaleJobsEnabled();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-end-stale-jobs.gate-endstalejobs-reads-false-unset-and: gate.endStaleJobs reads false unset and true when set [C7,#8816]', () => {
  assert.equal(enabledWith({}), false);
  assert.equal(enabledWith({ gate: { endStaleJobs: true } }), true);
});

test('config.io-settings-end-stale-jobs.a-non-boolean-gate-endstalejobs-is: a non-boolean gate.endStaleJobs is refused naming the setting [C7,#8816]', () => {
  assert.throws(() => enabledWith({ gate: { endStaleJobs: 'yes' } }), /gate\.endStaleJobs/u);
});
