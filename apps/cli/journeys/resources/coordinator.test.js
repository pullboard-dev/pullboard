/** A gate worker never outlives its dispatcher, and no test process starts on the coordinator [C7]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  coordinatorTestRefusal,
  testProcesses,
} from '../../../../packages/gate/index.js';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** An environment for a coordinator stand-in: a private machine home whose settings say gate.runnersOnly, and no runner job. */
function coordinatorEnv(files) {
  files.write('home/settings.json', JSON.stringify({ gate: { runnersOnly: true } }) + '\n');
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(files.root, 'home') };
  for (const name of ['PULLBOARD_RUNNER_JOB', 'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_TEST_RUNNER_PID', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[name];
  return env;
}

test('clause 2: run-tests and a bare node --test refuse on the coordinator without a runner job, naming pullboard test [C7]', () => {
  const files = privateFixtureFiles('pullboard-coordinator-tests-');
  const env = coordinatorEnv(files);
  files.write('probe.test.js', `import ${JSON.stringify(join(REPO, 'apps/cli/tests/fixtures/child.js'))};\nimport { test } from 'node:test';\ntest('probe [C7]', () => {});\n`);
  const runTests = spawnSync(process.execPath, [join(REPO, 'apps/cli/src/io/run/tests.js'), join(files.root, 'probe.test.js')], { cwd: files.root, env, encoding: 'utf8' });
  assert.equal(runTests.status, 2, runTests.stderr);
  assert.match(runTests.stderr, /\[TESTS_ON_COORDINATOR\].*pullboard test/u, 'run-tests names pullboard test as the way');
  const bare = spawnSync(process.execPath, ['--test', join(files.root, 'probe.test.js')], { cwd: files.root, env, encoding: 'utf8' });
  assert.notEqual(bare.status, 0, 'a bare node --test of a suite using the shared helpers fails');
  assert.match(bare.stdout + bare.stderr, /\[TESTS_ON_COORDINATOR\]/u);
  // A runner job may run tests; a machine that is not the coordinator may too.
  assert.equal(coordinatorTestRefusal({ env: { PULLBOARD_RUNNER_JOB: 'job-1' }, read: () => ({ gate: { runnersOnly: true } }) }), null);
  assert.equal(coordinatorTestRefusal({ env: {}, read: () => ({ gate: { runnersOnly: false } }) }), null);
});

test('clause 3: pullboard resources reports a test process running on the coordinator as a fault [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  // This project's machine is the coordinator: its machine settings say gate.runnersOnly.
  mkdirSync(isolated.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const settingsFile = join(isolated.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  writeFileSync(settingsFile, JSON.stringify({ ...settings, gate: { ...settings.gate, runnersOnly: true } }) + '\n');
  const local = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0)", '--', '--test'], { stdio: 'ignore' });
  t.after(() => { try { local.kill('SIGKILL'); } catch { /* already gone */ } });
  assert.deepEqual(testProcesses(`${local.pid} ${process.execPath} -e x -- --test\n 12 /usr/bin/ssh runner\n`).map(row => row.pid), [local.pid], 'a node --test process is a test process; others are not');
  const resources = (await box.runLocal(box.repo, 'resources', '--json'));
  assert.equal(resources.code, 0, `${resources.err}\n${resources.out}`);
  const faults = JSON.parse(resources.out).faults ?? [];
  assert.ok(faults.some(fault => fault.kind === 'test-on-coordinator' && fault.pid === local.pid), `the local test process is a fault: ${resources.out.slice(0, 400)}`);
});
