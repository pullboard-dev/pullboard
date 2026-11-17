/** gate.runnerDispatch names how runner jobs are watched: pull is the default and the only value; controller is refused with a next step [C7,P7,#5465,#8181]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { runnerDispatchMode } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

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

test('config.logic-settings-dispatch.clause-1-the-runner-dispatch-mode-is: clause 1: the runner dispatch mode is pull with no setting and with pull set [C7,P7,#5465]', () => {
  assert.equal(withSettings(null, runnerDispatchMode), 'pull');
  assert.equal(withSettings({ gate: {} }, runnerDispatchMode), 'pull');
  assert.equal(withSettings({ gate: { runnerDispatch: 'pull' } }, runnerDispatchMode), 'pull');
});

test('config.logic-settings-dispatch.clause-1-controller-and-any-other-runner: clause 1: controller and any other runner dispatch value is refused with the step to pull, and the schema holds no controller value [C7,#5465,#8181]', () => {
  for (const bad of ['controller', 'Pull', 'poll', true, 1, null]) {
    assert.throws(() => withSettings({ gate: { runnerDispatch: bad } }, loadMachineSettings),
      error => error.code === 'BAD_MACHINE_SETTINGS' && /must be "pull"/u.test(error.message) && /next: run pullboard settings gate\.runnerDispatch pull/u.test(error.message), `${JSON.stringify(bad)} is refused`);
  }
});
