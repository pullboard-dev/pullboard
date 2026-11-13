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
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
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

test('clause 1: when the dispatcher that launched a gate worker exits, the worker and the child it spawned exit within 30 s [C7]', { timeout: 60_000 }, async t => {
  const files = privateFixtureFiles('pullboard-lifeline-');
  const resources = join(REPO, 'packages/resources/index.js');
  const pids = join(files.root, 'pids.json');
  // The captured tools' driver: it spawns a child that stays up, records both pids, and stops on the real lifeline.
  files.write('tools/apps/cli/src/io/gate/drive.js', [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `import { onDispatcherLifelineEnd } from ${JSON.stringify(resources)};`,
    "const child = spawn(process.execPath, ['-e', \"require('node:net').createServer().listen(0)\"], { stdio: 'ignore' });",
    "onDispatcherLifelineEnd(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(143); } });",
    `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ worker: process.pid, child: child.pid }));`,
  ].join('\n'));
  files.write('job/request.json', '{}\n');
  // The real dispatcher drain, in its own process with a private machine home, starting that one queued worker.
  files.write('dispatcher.mjs', [
    `import { drainHandoffQueue, queueHandoffLaunch, reserveHandoffTicket } from ${JSON.stringify(resources)};`,
    `queueHandoffLaunch({ directory: ${JSON.stringify(join(files.root, 'job'))}, tools: ${JSON.stringify(join(files.root, 'tools'))}, commonDir: ${JSON.stringify(files.root)}, job: 'job-lifeline' }, await reserveHandoffTicket('job-lifeline'));`,
    'await drainHandoffQueue({ capacity: 1, pollMs: 20 });',
  ].join('\n'));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(files.root, 'machine') };
  const dispatcher = spawn(process.execPath, [join(files.root, 'dispatcher.mjs')], { env, stdio: 'ignore' });
  t.after(() => { try { process.kill(dispatcher.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await waitForCondition(() => existsSync(pids), 'the dispatcher started its worker', { signal: t.signal });
  const { worker, child } = JSON.parse(readFileSync(pids, 'utf8'));
  t.after(() => { for (const pid of [worker, child]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(gone(worker), false, 'the worker runs while its dispatcher lives');
  dispatcher.kill('SIGKILL');
  // The clause's own bound: both are gone within 30 s of the dispatcher's exit, or the wait aborts and the test fails.
  await waitForCondition(() => gone(worker) && gone(child), 'the worker and its child exit within 30 s of the dispatcher', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]) });
});

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
