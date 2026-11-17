/** serveOnce passes only the machine settings a journey names to its runner process, and none by default [P7,#7301]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './child.js';
import { pulledProfilePathsEnabled } from '../../../../packages/config/index.js';
import { serializeInProcess } from './process.js';
import { runnerEnv } from './pull.js';

/** Whether the runner's own settings read gate.pulledProfilePaths as on, read here under exactly the machine home its environment names. */
function pulledProfilePaths(env) {
  return serializeInProcess(() => {
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    if (env.PULLBOARD_MACHINE_HOME === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    try { return pulledProfilePathsEnabled(); } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  });
}

/** A box whose own environment holds PULLBOARD_ variables, as a journey's does. */
function box() {
  const runnerHome = privateFixtureFiles('pull-serve-settings-').root;
  return { runnerHome, env: { PATH: process.env.PATH, HOME: runnerHome, PULLBOARD_MACHINE_HOME: join(runnerHome, 'not-the-runners'), PULLBOARD_KEEP: 'no' } };
}

test('cli.pull-serve-settings.passes-named: clause 1: a runner started with {"gate":{"pulledProfilePaths":true}} reads that setting as on in the runner process [P7,#7301]', async () => {
  const one = box();
  assert.equal(await pulledProfilePaths(runnerEnv(one, 'r1', {}, { gate: { pulledProfilePaths: true } })), true);
});

test('cli.pull-serve-settings.default-clean: clause 2: with no machineSettings the runner environment holds no PULLBOARD_ variable but the steps file, and the setting reads off [P7,#7301]', async () => {
  const one = box();
  const env = runnerEnv(one, 'r1');
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('PULLBOARD_')), ['PULLBOARD_FIXTURE_STEPS']);
  assert.equal(await pulledProfilePaths(env), false);
});
