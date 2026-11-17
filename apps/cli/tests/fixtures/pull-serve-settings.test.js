/** serveOnce passes only the machine settings a journey names to its runner process, and none by default [P7,#7301]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './child.js';
import { runnerEnv } from './pull.js';

const CONFIG = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'config', 'index.js');

/** Run the runner process's own settings read under `env` and report it. */
function pulledProfilePaths(env) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import { pulledProfilePathsEnabled } from ${JSON.stringify(CONFIG)}; process.stdout.write(String(pulledProfilePathsEnabled()));`],
    { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

/** A box whose own environment holds PULLBOARD_ variables, as a journey's does. */
function box() {
  const runnerHome = privateFixtureFiles('pull-serve-settings-').root;
  return { runnerHome, env: { PATH: process.env.PATH, HOME: runnerHome, PULLBOARD_MACHINE_HOME: join(runnerHome, 'not-the-runners'), PULLBOARD_KEEP: 'no' } };
}

test('cli.pull-serve-settings.passes-named: clause 1: a runner started with {"gate":{"pulledProfilePaths":true}} reads that setting as on in the runner process [P7,#7301]', () => {
  const env = runnerEnv(box(), 'r1', {}, { gate: { pulledProfilePaths: true } });
  assert.equal(pulledProfilePaths(env), 'true');
});

test('cli.pull-serve-settings.default-clean: clause 2: with no machineSettings the runner environment holds no PULLBOARD_ variable but the steps file, and the setting reads off [P7,#7301]', () => {
  const env = runnerEnv(box(), 'r1');
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('PULLBOARD_')), ['PULLBOARD_FIXTURE_STEPS']);
  assert.equal(pulledProfilePaths(env), 'false');
});
