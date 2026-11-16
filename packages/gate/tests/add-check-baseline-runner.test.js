/** The add check baseline runs as a job on a runner, pulled or pushed, and never inline on the coordinator machine [C7,V2,#6560]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { runFixtureGit } from './fixtures/child.js';
import { policyRepository } from '../../store/tests/fixtures/submit.js';
import { fixtureMachineSettings } from './fixtures/testkit.js';
import { fixtureProjectPolicy } from './fixtures/testkit.js';
import { executionServices } from '../../../apps/cli/tests/fixtures/gate/execution.js';
import { HOST } from './fixtures/runner/ssh.js';
import { installSshStandIn } from './fixtures/runner/ssh.js';
import { measureBaseline } from '../src/io/check/baseline/worker.js';
import { CHECK_BASELINE_KIND } from '../../api/index.js';
import { offerCheckBaseline } from '../../api/index.js';
import { openKitBoard } from '../../board/tests/fixtures/board.js';

const EXPECTED = { command: 'node apps/cli/src/io/run/tests.js test/a.test.js', main: 'a'.repeat(40) };

test('clause 2: the in-process measurement runs nothing with no registered runner; the check is a pulled job, never inline on the host [C7,V2,#6560]', async () => {
  // No execution services at all: nothing may run locally.
  assert.equal(await measureBaseline('/nonexistent-root', 1, EXPECTED, {}), null);
  // Services whose runner list is empty: still nothing runs locally.
  let touched = 0;
  const services = { gateExecutionServices: async () => ({ runners: { effectiveRunners: () => { touched += 1; return []; } }, landing: {} }) };
  assert.equal(await measureBaseline('/nonexistent-root', 1, EXPECTED, services), null);
  assert.equal(touched, 1, 'the registered-runner list was consulted');
});

test('clause 1: the in-process measurement never starts a local test process; a result comes from a runner [C7,V2,#6560]', async () => {
  const services = { gateExecutionServices: async () => ({ runners: { effectiveRunners: () => [], runOnRunnerAsync: () => { throw new Error('no run without a runner'); } }, landing: {} }) };
  assert.equal(await measureBaseline('/nonexistent-root', 2, EXPECTED, services), null);
});

/** A repository with one failing test and a pinned main, with a registered runner reached through the real ssh stand-in. */
function runnerFixture(t) {
  const directory = privateFixtureFiles('pullboard-add-baseline-runner-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remote-home'].map(name => [name, join(directory, name)]));
  const remoteMachine = join(paths['remote-home'], '.pullboard');
  const remoteRoot = join(paths['remote-home'], '.pullboard-runner');
  for (const path of [...Object.values(paths), remoteMachine, remoteRoot, join(paths.repo, 'test')]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    PATH: `${paths.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Baseline Runner Fixture', GIT_AUTHOR_EMAIL: 'baseline@example.invalid',
    GIT_COMMITTER_NAME: 'Baseline Runner Fixture', GIT_COMMITTER_EMAIL: 'baseline@example.invalid' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  policyRepository(paths.repo);
  writeFileSync(join(paths.repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  fixtureProjectPolicy(paths.repo, { config: { gate: 'node test/runner.js', affectedTests: 'node test/runner.js' } });
  writeFileSync(join(paths.repo, 'test/failing.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('the baseline failure is named [V2]', () => assert.equal(1, 2));",
  ].join('\n') + '\n');
  writeFileSync(join(paths.repo, 'test/runner.js'), [
    "import { spawnSync } from 'node:child_process';",
    "const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  runFixtureGit(['add', '-A'], { cwd: paths.repo, env });
  runFixtureGit(['commit', '-qm', 'test: pin a failing main case'], { cwd: paths.repo, env });
  const runners = [{ host: HOST, slots: 1, browser: 0, node: process.execPath, root: remoteRoot }];
  fixtureMachineSettings(paths.machine, { gateSlots: 0, browserSlots: 0, gate: { browserFreeChecks: true, timingRunner: false }, runners });
  const requests = join(directory, 'ssh-requests.jsonl');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths['remote-home'], machineHome: remoteMachine, requests, nodeCommand: process.execPath });
  return { ...paths, env, requests, main: runFixtureGit(['rev-parse', 'HEAD'], { cwd: paths.repo, env }).trim() };
}

test('clause 1: with a registered runner the baseline runs there and returns its measured result [C7,V2]', { timeout: 90000 }, async t => {
  const box = runnerFixture(t);
  const prior = { home: process.env.PULLBOARD_HOME, machine: process.env.PULLBOARD_MACHINE_HOME, agent: process.env.PULLBOARD_AGENT,
    path: process.env.PATH, accountHome: process.env.HOME };
  Object.assign(process.env, { PULLBOARD_HOME: box.home, PULLBOARD_MACHINE_HOME: box.machine, PULLBOARD_AGENT: 'baseline-runner-fixture',
    PATH: box.env.PATH, HOME: box.home });
  t.after(() => {
    for (const [name, value] of [['PULLBOARD_HOME', prior.home], ['PULLBOARD_MACHINE_HOME', prior.machine], ['PULLBOARD_AGENT', prior.agent], ['PATH', prior.path], ['HOME', prior.accountHome]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const expected = { command: 'node test/runner.js ./test/failing.test.js', main: box.main };
  const baseline = await measureBaseline(box.repo, 7, expected, { gateExecutionServices: async () => executionServices });
  assert.ok(baseline, 'a registered runner produced an observation');
  assert.equal(baseline.result, 'red', 'the runner ran the failing case at the captured main');
  assert.equal(baseline.main, box.main);
  assert.equal(baseline.command, expected.command);
  assert.ok(readFileSync(box.requests, 'utf8').trim().length > 0, 'the run went through the runner transport, not a local process');
});

test('clause 3: with no registered runner the baseline is offered as a check-baseline pull job that carries the check and main, never run here [C7,V2,#6560]', t => {
  const directory = privateFixtureFiles('pullboard-baseline-offer-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = openKitBoard(join(directory, 'board.sqlite'));
  const expected = { command: 'node test/a.test.js', main: 'b'.repeat(40), request: '11111111-2222-3333-4444-555555555555' };
  const offered = offerCheckBaseline(board.db, { item: 9, expected, command: expected.command });
  const row = board.db.prepare('SELECT job_kind, job_item, job_candidate FROM job WHERE job_id = ?').get(offered.id);
  assert.deepEqual({ ...row }, { job_kind: CHECK_BASELINE_KIND, job_item: 9, job_candidate: expected.main });
  assert.equal(offerCheckBaseline(board.db, { item: 9, expected, command: expected.command }).id, offered.id, 'a retried add reuses the open job');
});
