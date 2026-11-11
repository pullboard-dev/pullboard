/** gate.runnerDispatch names how runner jobs are watched: controller by default, pull only when set exactly [C7,#5465]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { runnerDispatchMode } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../apps/cli/tests/fixtures/testkit.js';

/** Point the machine home at a private directory holding the given settings, and restore it afterwards. */
function withSettings(settings, work) {
  const { root: dir } = privateFixtureFiles('pullboard-runner-dispatch-setting-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    if (settings) fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return work();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('the runner dispatch mode is controller until the machine setting is exactly pull [C7,#5465]', () => {
  assert.equal(withSettings(null, runnerDispatchMode), 'controller');
  assert.equal(withSettings({ gate: {} }, runnerDispatchMode), 'controller');
  assert.equal(withSettings({ gate: { runnerDispatch: 'controller' } }, runnerDispatchMode), 'controller');
  assert.equal(withSettings({ gate: { runnerDispatch: 'pull' } }, runnerDispatchMode), 'pull');
});

test('any other runner dispatch value is a machine settings refusal that names the two choices [C7,#5465]', () => {
  for (const bad of ['Pull', 'poll', true, 1, null]) {
    assert.throws(() => withSettings({ gate: { runnerDispatch: bad } }, loadMachineSettings), /BAD_MACHINE_SETTINGS.*"controller" or "pull"/u, `${JSON.stringify(bad)} is refused`);
  }
});
