/** serveBackground starts a runner serve that keeps serving until stop() signals its one pid, and passes named machine settings as serveOnce does [P7,#7301,#9880]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pulledProfilePathsEnabled } from '../../../../packages/config/index.js';
import { serializeInProcess } from './process.js';
import { pullProject } from './pull.js';
import { pullQueue } from './pull.js';
import { serveBackground } from './pull.js';

/** Whether the runner's own settings read gate.pulledProfilePaths as on, read under exactly the machine home its environment names. */
function pulledProfilePaths(env) {
  return serializeInProcess(() => {
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    if (env.PULLBOARD_MACHINE_HOME === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    try { return pulledProfilePathsEnabled(); } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  });
}

test('cli.pull-background.closed-after-stop: clause 1: serveBackground returns a handle whose closed promise resolves with the runner serve exit code after stop() signals that one pid [P7,#9880]', async t => {
  const box = await pullProject(t, 1);
  const queue = await pullQueue(t, box);
  const served = await serveBackground(box, queue.url, 'r-background');
  assert.ok(Number.isInteger(served.pid) && served.pid > 0, 'the handle names the runner serve process');
  assert.equal(await Promise.race([served.closed.then(() => 'closed'), Promise.resolve('serving')]), 'serving', `the serve keeps serving until it is stopped:\n${served.output()}`);
  served.stop();
  assert.equal(await served.closed, 0, served.output());
});

test('cli.pull-background.machine-settings-reach-runner: clause 2: a machineSettings value given to serveBackground is read as set by the runner process, as serveOnce passes it [P7,#7301,#9880]', async t => {
  const box = await pullProject(t, 1);
  const queue = await pullQueue(t, box);
  const served = await serveBackground(box, queue.url, 'r-background-settings', {}, { machineSettings: { gate: { pulledProfilePaths: true } } });
  t.after(() => served.stop());
  assert.equal(await pulledProfilePaths(served.env), true);
  served.stop();
  await served.closed;
});
