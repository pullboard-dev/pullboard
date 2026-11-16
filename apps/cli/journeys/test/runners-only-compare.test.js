/** With gate.runnersOnly on, a main comparison runs as a runner job, never as a local process [C7,#8927]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareMainFailures } from '../../../../packages/landing/index.js';
import { gateRunnerAdmission } from '../../../../packages/config/index.js';
import { withEnvironment } from '../../../../packages/resources/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';

const roots = [];

function fixture(t, tag) {
  const hosts = { A: `${HOST}-${tag}`, B: `${HOST}-${tag}-drop`, C: `${HOST}-${tag}-setup` };
  const directory = privateFixtureFiles('pullboard-runners-only-').root;
  roots.push(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  const graph = fixtureCommittedGraph('pullboard-runners-only-repo-');
  const paths = Object.fromEntries(['bin', 'home', 'machine', 'worker', 'remote-home'].map(name => [name, join(directory, name)]));
  const remoteMachine = join(paths['remote-home'], '.pullboard');
  const remoteRoot = join(paths['remote-home'], '.pullboard-runner');
  paths.repo = graph.root;
  for (const path of [...Object.values(paths), remoteMachine, remoteRoot, join(paths.repo, 'test')]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    PATH: `${paths.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Compare Runner Fixture', GIT_AUTHOR_EMAIL: 'compare@example.invalid',
    GIT_COMMITTER_NAME: 'Compare Runner Fixture', GIT_COMMITTER_EMAIL: 'compare@example.invalid' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  graph.put('package.json', JSON.stringify({ private: true, type: 'module' }) + '\n');
  fixtureProjectPolicy(paths.repo, { config: { gate: 'node test/runner.js', affectedTests: 'node test/runner.js' } });
  graph.put('test/inherited.test.js', [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('the inherited main failure stays named [V4]', () => assert.equal(1, 2));",
  ].join('\n') + '\n');
  graph.put('test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  const main = graph.commit();
  const runners = Object.values(hosts).map(host => ({ host, slots: 1, browser: 0, node: process.execPath, root: remoteRoot }));
  fixtureMachineSettings(paths.machine, { gateSlots: 0, browserSlots: 0, gate: { browserFreeChecks: true, timingRunner: false, runnersOnly: true }, runners });
  const requests = join(directory, 'ssh-requests.jsonl');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths['remote-home'], machineHome: remoteMachine,
    requests, nodeCommand: process.execPath, hosts: Object.values(hosts) });
  return { ...paths, hosts, root: paths.repo, machine: paths.machine, home: paths.home, runners, requests,
    main, env };
}

test('clause 1: gate.runnersOnly on makes the default admission runner-only, so a main comparison never runs locally [C7,#8927]', { timeout: 60000 }, async t => {
  const box = fixture(t, 'only');
  const started = [];
  await withEnvironment(box.env, async () => {
    const admission = gateRunnerAdmission();
    assert.equal(admission.runnerOnly, true);
    assert.equal(admission.remote, true);
    const compared = await compareMainFailures(box.root, { tests: [{ file: 'test/inherited.test.js', passed: false }] }, undefined, '', {
      env: box.env, commit: box.main, detailed: true, fresh: true, onStart: start => started.push(start),
    });
    assert.equal(compared.unavailable, undefined, compared.unavailable);
    assert.equal(compared.files[0]?.result, 'red', 'the main side ran and reports its red');
    assert.ok(started.length > 0, 'the comparison started a run');
    for (const start of started) assert.ok(box.hosts.A === start.runner || Object.values(box.hosts).includes(start.runner), `ran on a registered runner, not locally: ${start.runner}`);
  });
});
