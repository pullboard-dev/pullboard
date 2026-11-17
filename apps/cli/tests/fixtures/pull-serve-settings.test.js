/** serveOnce passes only the machine settings a journey names to its runner process, and none by default [P7,#7301]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './child.js';
import { runCliInProcess } from './process.js';
import { runnerEnv } from './pull.js';

/** What `pullboard settings` prints for gate.pulledProfilePaths under the runner's environment, read in this process. */
async function pulledProfilePaths(box, env) {
  const shown = await runCliInProcess(['settings'], { cwd: box.runnerHome, env });
  assert.equal(shown.status, 0, shown.stderr);
  return /^gate\.pulledProfilePaths: (\w+)/mu.exec(shown.stdout)?.[1];
}

/** A box whose own environment holds PULLBOARD_ variables, as a journey's does. */
function box() {
  const runnerHome = privateFixtureFiles('pull-serve-settings-').root;
  return { runnerHome, env: { PATH: process.env.PATH, HOME: runnerHome, PULLBOARD_MACHINE_HOME: join(runnerHome, 'not-the-runners'), PULLBOARD_KEEP: 'no' } };
}

test('cli.pull-serve-settings.passes-named: clause 1: a runner started with {"gate":{"pulledProfilePaths":true}} reads that setting as on in the runner process [P7,#7301]', async () => {
  const one = box();
  assert.equal(await pulledProfilePaths(one, runnerEnv(one, 'r1', {}, { gate: { pulledProfilePaths: true } })), 'true');
});

test('cli.pull-serve-settings.default-clean: clause 2: with no machineSettings the runner environment holds no PULLBOARD_ variable but the steps file, and the setting reads off [P7,#7301]', async () => {
  const one = box();
  const env = runnerEnv(one, 'r1');
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('PULLBOARD_')), ['PULLBOARD_FIXTURE_STEPS']);
  assert.equal(await pulledProfilePaths(one, env), 'false');
});
