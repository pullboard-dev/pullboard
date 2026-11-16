/** A pinned main comparison may use only a registered runner with the candidate's observed environment [V4,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { describe } from 'node:test';
import { test } from 'node:test';
import { compareMainFailures } from '../../../../index.js';
import { comparisonExecutor } from '../../../../index.js';
import { executionEnvironment } from '../../../../../sandbox/index.js';
import { runProfiledShellAsync } from '../../../../../gate/index.js';
import { withGateSlot } from '../../../../../gate/index.js';
import { recordReceipt } from '../../../../../gate/index.js';
import { failureSignatures } from '../../../../index.js';
import { matchingMainFailures } from '../../../../index.js';
import { takeResource } from '../../../../../resources/index.js';
import { withEnvironment } from '../../../../../resources/index.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { executionServices } from '../../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { HOST } from '../../../../../gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../gate/tests/fixtures/runner/ssh.js';

const A = HOST;
const B = `${HOST}-drop`;
const C = `${HOST}-setup`;
const roots = [];

/**
 * One case's complete environment: the fixture's own homes and runner stand-in, and the agent it runs as. A case passes it to
 * the calls that take an env and runs its setup calls under it, so two cases run at once without sharing process.env.
 */
function caseEnvironment(box, agent) {
  return Object.assign({ ...process.env }, { PULLBOARD_HOME: box.home, PULLBOARD_MACHINE_HOME: box.machine,
    PULLBOARD_AGENT: agent, PATH: box.env.PATH, HOME: box.home });
}

/** Concurrent: each real-gate case names its own runner hosts, so the gate's per-host unavailability and avoidance state is never shared [C7]. */
describe('registered runner selection for a pinned main comparison [V4,C7]', { concurrency: true }, () => {
test('clause 1: with the case\'s own env, main comparison selects a matching registered peer only when the preferred runner is busy [V4,C7]', { timeout: 60000 }, async t => {
  const box = fixture(t, 'peer');
  const { A, B, C } = box.hosts;
  const environment = executionEnvironment();
  const env = caseEnvironment(box, 'comparison-peer-fixture');
  await withEnvironment(env, async () => {
  let held;
  const measured = [];
  const candidateReceipts = [];
  let execution = { executor: { kind: 'ssh', host: A }, environment };
  try {
    [A, B].map(host => receipt(box.root, host, environment)).forEach(record => recordReceipt(box.root, record));
    recordReceipt(box.root, receipt(box.root, C, { ...environment, node: '0.0.0' }));

    const eligible = comparisonExecutor(box.root, execution);
    assert.deepEqual(eligible, {
      requiredExecutor: { kind: 'ssh', host: A, hosts: [A, B] },
      browser: false,
    }, 'the original runner stays first and the wrong-Node peer is excluded');

    recordReceipt(box.root, receipt(box.root, A, { ...environment, node: '0.0.1' }));
    assert.deepEqual(comparisonExecutor(box.root, execution), {
      requiredExecutor: { kind: 'ssh', host: A, hosts: [A] },
      browser: null,
    }, 'a changed runtime on A runs the comparison on A itself and peer B is not chosen');

    recordReceipt(box.root, receipt(box.root, A, environment));
    recordReceipt(box.root, receipt(box.root, B, null));
    assert.deepEqual(comparisonExecutor(box.root, execution), {
      requiredExecutor: { kind: 'ssh', host: A, hosts: [A] },
      browser: false,
    }, 'an incomplete newest observation on B blocks stale peer eligibility');
    recordReceipt(box.root, receipt(box.root, B, environment));

    const candidate = await withGateSlot(box.root, lease => runProfiledShellAsync(box.root,
      "node test/runner.js './test/inherited.test.js'", { gateLease: lease, stages: true }), {
      env, executionServices, remote: true, runnerOnly: true, runnerWaitMs: 30000, requiredExecutor: { kind: 'ssh', host: A },
      diagnostic: true, agent: 'actual-candidate-runner-fixture', kind: 'candidate-comparison-control',
      onReceipt: value => candidateReceipts.push(value),
    });
    assert.equal(candidate.executionRunner, A, 'the named candidate failure is executed on the actual preferred runner');
    assert.deepEqual(candidate.environment, environment, 'the candidate receipt captures the complete runtime');
    const candidateFailures = failureSignatures(candidate, box.root);
    assert.ok(candidateFailures?.length, 'the actual candidate run has complete named failure signatures');
    assert.equal(candidateReceipts.at(-1)?.runner?.id, A, 'the candidate lease receipt identifies its real runner');
    execution = { executor: { kind: 'ssh', host: A }, environment: candidate.environment };
    assert.deepEqual(comparisonExecutor(box.root, execution).requiredExecutor.hosts, [A, B]);

    held = await takeResource({ env, name: 'gate', capacity: 0, scope: 'machine', root: box.root,
      remote: true, requiredExecutor: { kind: 'ssh', host: A, hosts: [A] },
      runnerProvider: () => box.runners, agent: 'hold-preferred-comparison-runner', kind: 'comparison-affinity-control' });
    const compare = () => compareMainFailures(box.root, { tests: [{ file: 'test/inherited.test.js', passed: false }] }, undefined, '', {
      env, commit: box.main, detailed: true, fresh: true, execution,
      runnerAdmission: { runnerOnly: true, runnerWaitMs: 30000, onReceipt: value => measured.push(value) },
    });
    const whileABusy = await compare();
    assert.equal(whileABusy.unavailable, undefined, whileABusy.unavailable);
    assert.equal(whileABusy.files[0].file, 'test/inherited.test.js');
    assert.equal(whileABusy.files[0].result, 'red');
    assert.ok(whileABusy.files[0].failures?.length, 'the focused comparison retains the exact main failure signature');
    assert.equal(measured.at(-1)?.runner?.id, B, 'the actual comparison lease receipt names the available matching peer');
    assert.deepEqual(measured.at(-1)?.environment, environment, 'the actual remote worker reports the candidate runtime');
    assert.deepEqual(matchingMainFailures(candidateFailures, whileABusy, box.main), {
      main: box.main, failures: candidateFailures,
    }, 'the actual matching peer comparison accepts only the candidate’s exact named red');

    held.release();
    held = null;
    const runs = measured.length;
    const withAFree = await compare();
    assert.equal(withAFree.unavailable, undefined, withAFree.unavailable);
    assert.equal(withAFree.files[0].result, 'red');
    assert.deepEqual(withAFree.files[0].failures, whileABusy.files[0].failures,
      'the retained matching peer comparison keeps the same named main failure');
    // Pinned exact-main evidence is reused for the same executor and runtime, so no second comparison runs.
    assert.equal(measured.length, runs, 'the retained comparison is reused rather than rerun on the preferred runner');
  } finally {
    held?.release();
  }
  });

  const requests = readFileSync(box.requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const workers = requests.filter(row => row.workerStarted);
  assert.deepEqual(workers.map(row => row.host), [A, B], 'the candidate and the alternate comparison run on their expected hosts');
  assert.ok(requests.every(row => row.host !== C), 'the wrong-Node runner never receives a comparison');
});

/** Run comparisonExecutor against a fixture pool with the given recorded receipts, in an environment of its own. */
function selectWith(t, record) {
  const box = fixture(t);
  const environment = executionEnvironment();
  return withEnvironment(Object.assign({ ...process.env }, { PULLBOARD_HOME: box.home, PULLBOARD_MACHINE_HOME: box.machine }), () => {
    record(box.root, environment);
    return comparisonExecutor(box.root, { executor: { kind: 'ssh', host: A }, environment });
  });
}

test('clause 1: the real compare-main path runs main on the red host when no receipt matches, never BAD_RUNNER_POOL [C7]', { timeout: 60000 }, async t => {
  const box = fixture(t, 'red');
  const { A, B, C } = box.hosts;
  const environment = executionEnvironment();
  const env = caseEnvironment(box, 'comparison-red-host-fixture');
  await withEnvironment(env, async () => {
  const measured = [];
  try {
    // Every registered peer's newest receipt names another runtime, so no peer observation matches the red run.
    for (const host of [A, B, C]) recordReceipt(box.root, receipt(box.root, host, { ...environment, node: '0.0.1' }));
    const compared = await compareMainFailures(box.root, { tests: [{ file: 'test/inherited.test.js', passed: false }] }, undefined, '', {
      env, commit: box.main, detailed: true, fresh: true, execution: { executor: { kind: 'ssh', host: A }, environment },
      runnerAdmission: { runnerOnly: true, runnerWaitMs: 30000, onReceipt: value => measured.push(value) },
    });
    assert.equal(compared.unavailable, undefined, compared.unavailable);
    assert.equal(compared.files[0]?.file, 'test/inherited.test.js');
    assert.equal(compared.files[0]?.result, 'red', 'the main side ran and reports its case-level red');
    assert.ok(compared.files[0]?.failures?.length, 'the comparison names the main failure case');
    assert.equal(measured.at(-1)?.runner?.id, A, 'the comparison ran on the red run host');
  } finally {
  }
  });
});

test('clause 1: registered runners with no matching receipts select the red host, never BAD_RUNNER_POOL [C7]', t => {
  const none = selectWith(t, () => {});
  assert.deepEqual(none, { requiredExecutor: { kind: 'ssh', host: A, hosts: [A] }, browser: null },
    'no receipts at all selects the red run host');
  const stale = selectWith(t, (root, environment) => {
    recordReceipt(root, receipt(root, A, { ...environment, node: '0.0.1' }));
    recordReceipt(root, receipt(root, B, { ...environment, node: '0.0.2' }));
  });
  assert.deepEqual(stale, { requiredExecutor: { kind: 'ssh', host: A, hosts: [A] }, browser: null },
    'receipts that do not match the red environment still select the red run host');
});

test('clause 2: a peer whose recorded environment differs from the red run is never chosen [C7]', t => {
  const picked = selectWith(t, (root, environment) => {
    recordReceipt(root, receipt(root, A, environment));
    recordReceipt(root, receipt(root, B, environment));
    recordReceipt(root, receipt(root, C, { ...environment, node: '0.0.0' }));
  });
  assert.deepEqual(picked.requiredExecutor.hosts, [A, B], 'only the matching peer joins the red host');
  assert.ok(!picked.requiredExecutor.hosts.includes(C), 'the wrong-Node peer C is excluded');
});
});

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/** Build one recent structured receipt; null models a newer incomplete observation. */
function receipt(root, host, environment) {
  const finishedAt = new Date(Date.now() - 1000).toISOString();
  const admittedAt = new Date(Date.parse(finishedAt) - 100).toISOString();
  return {
    at: finishedAt, admittedAt, finishedAt, waitMs: 1, runMs: 2, kind: 'gate',
    slot: { kind: 'runner', reason: `registered runner ${host} had a free slot` },
    runner: { id: host, kind: 'ssh', slots: { current: 1, limit: 1, elastic: false },
      capabilities: { os: environment?.platform ?? process.platform, browser: false } },
    ...(environment ? { environment } : {}),
  };
}

/** Create a private committed project, machine runner pool and local SSH worker stand-in. */
function fixture(t, tag) {
  const hosts = tag ? { A: `${HOST}-${tag}`, B: `${HOST}-${tag}-drop`, C: `${HOST}-${tag}-setup` } : { A, B, C };
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-compare-any-runner-'));
  roots.push(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remote-home'].map(name => [name, join(directory, name)]));
  const remoteMachine = join(paths['remote-home'], '.pullboard');
  const remoteRoot = join(paths['remote-home'], '.pullboard-runner');
  for (const path of [...Object.values(paths), remoteMachine, remoteRoot, join(paths.repo, 'test')]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    PATH: `${paths.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Compare Runner Fixture', GIT_AUTHOR_EMAIL: 'compare@example.invalid',
    GIT_COMMITTER_NAME: 'Compare Runner Fixture', GIT_COMMITTER_EMAIL: 'compare@example.invalid' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: paths.repo, env });
  writeFileSync(join(paths.repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  writeFileSync(join(paths.repo, 'pullboard.json'), JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js' }) + '\n');
  writeFileSync(join(paths.repo, 'test/inherited.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('the inherited main failure stays named [V4]', () => assert.equal(1, 2));",
  ].join('\n') + '\n');
  writeFileSync(join(paths.repo, 'test/runner.js'), [
    "import { spawnSync } from 'node:child_process';",
    "const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  runFixtureGit(['add', '-A'], { cwd: paths.repo, env });
  runFixtureGit(['commit', '-qm', 'test: pin a named main failure'], { cwd: paths.repo, env });
  const runners = Object.values(hosts).map(host => ({ host, slots: 1, browser: 0, node: process.execPath, root: remoteRoot }));
  writeFileSync(join(paths.machine, 'settings.json'), JSON.stringify({ gateSlots: 0, browserSlots: 0, gate: { browserFreeChecks: true, timingRunner: false }, runners }) + '\n', { mode: 0o600 });
  const requests = join(directory, 'ssh-requests.jsonl');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths['remote-home'], machineHome: remoteMachine,
    requests, nodeCommand: process.execPath, hosts: Object.values(hosts) });
  return { ...paths, hosts, root: paths.repo, machine: paths.machine, home: paths.home, runners, requests,
    main: runFixtureGit(['rev-parse', 'HEAD'], { cwd: paths.repo, env }).trim(), env };
}
