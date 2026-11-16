/** @pullboard-test-input packages/gate/src/io/test/action/reporter.js */
/** Exercise cache exchange through real worker capsules in two isolated SSH fixture machines [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { copyRunnerPackage } from './package.js';
import { testResultStore } from '../../../gate/index.js';
import { runOnRunnerAsync } from '../../index.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import {
  HOST,
  installSshStandIn,
} from '../../../../apps/cli/tests/fixtures/runner/ssh.js';

const SOURCE = resolve(import.meta.dirname, '../../../..');
const EXECUTED = 'EXECUTED-FLEET-CACHE-PROBE';

/**
 * Prove the production request/worker/result path, without contacting a host or changing real runner settings.
 * Why: a cold first round trip takes about 110 s on a loaded runner, so only the cross-machine reuse runs here, in two trips; closure, harness, red and environment keys are cell tests in packages/gate/tests/io/test/action/reuse-parts.test.js.
 */
export async function fleetTestResultReuse(t, { composition = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-result-fleet-')));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  const worker = join(directory, 'worker');
  const controller = join(directory, 'controller');
  const homeA = join(directory, 'machine-a');
  const homeB = join(directory, 'machine-b');
  for (const folder of [repo, bin, worker, controller, homeA, homeB, join(repo, 'test'), join(repo, 'lib')]) mkdirSync(folder, { recursive: true });
  copyRunnerPackage(SOURCE, repo);
  const shippedManifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...shippedManifest, name: 'fleet-cache-fixture', private: true, type: 'module' }) + '\n');
  writeFileSync(join(repo, 'lib', 'value.js'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'test/probe.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { value } from '../lib/value.js';
test('fleet cache probe [C7]', () => { console.log('${EXECUTED}'); assert.ok(value > 0); });
`);
  if (composition) {
    writeFileSync(join(repo, 'reporter.mjs'), "export { tap as default } from 'node:test/reporters';\n");
    writeFileSync(join(repo, 'lib', 'stable.js'), 'export const stable = 1;\n');
    writeFileSync(join(repo, 'test/stable.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stable } from '../lib/stable.js';
test('unchanged companion closure [C7,V4]', () => { console.log('EXECUTED-STABLE'); assert.equal(stable, 1); });
`);
  }
  if (composition) writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node apps/cli/src/io/run/tests.js test/probe.test.js test/stable.test.js' }) + '\n');
  const env = { ...process.env, HOME: controller, PULLBOARD_HOME: controller,
    PULLBOARD_MACHINE_HOME: join(controller, '.pullboard'), PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cache Fixture', GIT_AUTHOR_EMAIL: 'cache@example.invalid',
    GIT_COMMITTER_NAME: 'Cache Fixture', GIT_COMMITTER_EMAIL: 'cache@example.invalid' };
  /** Commit exact fixture inputs with real Git. */
  const git = (...args) => runFixtureGit(args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'test: commit cache fixture');
  const policyCommit = git('rev-parse', 'HEAD').trim();
  const changedEnv = ['HOME', 'PATH', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME',
    'PULLBOARD_TEST_RESULT_STORE', 'PULLBOARD_TEST_RESULT_ORIGIN', 'PULLBOARD_TEST_RESULT_REQUEST', 'PULLBOARD_TEST_CACHE_TOOLING',
    // This test opts in to reuse, as recordTestAction documents, so its fixture runners exchange results.
    'PULLBOARD_TEST_REUSE'];
  const previous = Object.fromEntries(changedEnv.map(key => [key, process.env[key]]));
  for (const key of changedEnv) {
    if (key.startsWith('PULLBOARD_TEST_')) delete process.env[key];
    else process.env[key] = env[key];
  }
  /** Use a fresh worker HOME and persistent namespace, through the unchanged authenticated SSH transport. */
  let invocation = 0;
  const run = async (home, host, stage) => {
    invocation++;
    installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'),
      requests: join(home, 'requests.jsonl'), nodeCommand: process.execPath,
      nodeOptions: '' });
    const command = `node apps/cli/src/io/run/tests.js test/probe.test.js${composition ? ' test/stable.test.js' : ''}`;
    const checkedSource = { commit: git('rev-parse', 'HEAD').trim(), tree: git('rev-parse', 'HEAD^{tree}').trim() };
    const began = Date.now();
    const result = await runOnRunnerAsync(repo, command, {
      runner: { host, slots: 1, browser: 0, node: process.execPath, root: join(home, 'runner') },
      metadata: { item: 'fixture', kind: 'remote-command', testStage: stage, trunk: { ref: 'refs/heads/main', commit: policyCommit } },
      ...(composition && stage === 'verify' ? { checkedSource,
        privateCheck: { kind: 'private-check', version: 1, install: '', check: command, timeoutMs: 120000,
          policyCommit, trunk: { ref: 'refs/heads/main', commit: policyCommit }, guard: null },
        rawOutputPath: join(directory, `private-${invocation}.raw.log`) } : {}),
    });
    console.log(`# trip ${invocation} ${stage} ${((Date.now() - began) / 1000).toFixed(1)} s, worker ${((result.remoteWallMs ?? 0) / 1000).toFixed(1)} s`);
    if (composition && stage === 'verify') assert.equal(result.privateCheck.state, 'pass', result.output);
    return result;
  };
  try {
    const first = await run(homeA, HOST, 'submit');
    assert.equal(first.isGreen, true, first.output);
    assert.match(first.output, new RegExp(EXECUTED), 'the first worker really executes the test body');
    assert.doesNotMatch(first.output, /^# reused /mu);
    const second = await run(homeB, `${HOST}-setup`, 'verify');
    assert.equal(second.isGreen, true, second.output);
    assert.notEqual(first.executionRoot, second.executionRoot, 'the workers use different private machine namespaces');
    assert.doesNotMatch(second.output, new RegExp(EXECUTED), 'the second worker never executes the body');
    assert.match(second.output, new RegExp(`^# all ${composition ? 2 : 1} test files reused; none ran$`, 'mu'));
    assert.doesNotMatch(second.output, /EXECUTED-STABLE/u);
    assert.match(second.output, /^# reused [0-9a-f]{64} from submit /mu);
    const origin = JSON.parse(second.output.split('\n').find(line => line.startsWith('# result-origin ')).slice('# result-origin '.length));
    assert.equal(origin.machine, HOST, 'the real first worker remains the origin');
    assert.equal(origin.stage, 'submit');
    assert.equal(origin.completion.id, first.executionReceipt.id, 'reuse cites the original authenticated completion, not the verify request');
    assert.equal(origin.completion.tree, first.executionSource.tree);
    assert.notEqual(origin.completion.id, second.executionReceipt.id);
    const retained = JSON.parse(readFileSync(join(testResultStore(repo), 'completions', origin.completion.id + '.json'), 'utf8'));
    assert.equal(retained.id, first.executionReceipt.id);
    assert.equal(retained.outputSha256, origin.completion.outputSha256);
    assert.equal(retained.code, 0);
  } finally {
    for (const key of changedEnv) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
