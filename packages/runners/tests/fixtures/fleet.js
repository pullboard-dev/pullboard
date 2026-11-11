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
import { pathToFileURL } from 'node:url';
import { copyPackageFiles } from '../../index.js';
import { selectedTestResults } from '../../../gate/index.js';
import { testActionKeys } from '../../../gate/index.js';
import { testResultStore } from '../../../gate/index.js';
import { runOnRunnerAsync } from '../../index.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import {
  HOST,
  installSshStandIn,
} from '../../../../apps/cli/tests/fixtures/runner/ssh.js';

const SOURCE = resolve(import.meta.dirname, '../../../..');
const EXECUTED = 'EXECUTED-FLEET-CACHE-PROBE';

/** Prove the production request/worker/result path, without contacting a host or changing real runner settings. */
export async function fleetTestResultReuse(t, { composition = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-result-fleet-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  const worker = join(directory, 'worker');
  const controller = join(directory, 'controller');
  const homeA = join(directory, 'machine-a');
  const homeB = join(directory, 'machine-b');
  for (const folder of [repo, bin, worker, controller, homeA, homeB, join(repo, 'test'), join(repo, 'lib')]) mkdirSync(folder, { recursive: true });
  copyPackageFiles(SOURCE, repo);
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
  if (composition) writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node packages/gate/src/io/run/tests.js test/probe.test.js test/stable.test.js' }) + '\n');
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
  const languagePreload = join(homeB, 'language.mjs');
  writeFileSync(languagePreload, "process.env.LANG = 'cache-material-language';\n");
  let invocation = 0;
  const run = async (home, host, stage, differentLanguage = false, customReporter = false) => {
    invocation++;
    installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'),
      requests: join(home, 'requests.jsonl'), nodeCommand: process.execPath,
      nodeOptions: differentLanguage ? `--import=${pathToFileURL(languagePreload).href}` : '' });
    const command = `node packages/gate/src/io/run/tests.js test/probe.test.js${composition ? ' test/stable.test.js' : ''}${customReporter ? ' --test-reporter=./reporter.mjs' : ''}`;
    const checkedSource = { commit: git('rev-parse', 'HEAD').trim(), tree: git('rev-parse', 'HEAD^{tree}').trim() };
    const result = await runOnRunnerAsync(repo, command, {
      runner: { host, slots: 1, browser: 0, node: process.execPath, root: join(home, 'runner') },
      metadata: { testStage: stage, trunk: { ref: 'refs/heads/main', commit: policyCommit } },
      ...(composition && stage === 'verify' ? { checkedSource,
        privateCheck: { kind: 'private-check', version: 1, install: '', check: command, timeoutMs: 120000,
          policyCommit, trunk: { ref: 'refs/heads/main', commit: policyCommit }, guard: null },
        rawOutputPath: join(directory, `private-${invocation}.raw.log`) } : {}),
    });
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
    if (composition) {
      const reporter = await run(homeB, `${HOST}-setup`, 'verify', false, true);
      assert.equal(reporter.isGreen, true, reporter.output);
      assert.match(reporter.output, new RegExp(EXECUTED));
      assert.match(reporter.output, /EXECUTED-STABLE/u);
      assert.doesNotMatch(reporter.output, /^# reused /mu, 'caller-selected reporters cannot use the reporter-free harness shortcut');
    }
    const differentEnvironment = await run(homeB, `${HOST}-setup`, 'verify', true);
    assert.equal(differentEnvironment.isGreen, true, differentEnvironment.output);
    assert.match(differentEnvironment.output, new RegExp(EXECUTED), 'a material execution environment change requires a fresh body');
    assert.doesNotMatch(differentEnvironment.output, /^# reused /mu);
    if (composition) assert.match(differentEnvironment.output, /EXECUTED-STABLE/u);
    const beforeComposition = composition ? await testActionKeys(repo, { files: ['test/probe.test.js', 'test/stable.test.js'] }) : null;
    writeFileSync(join(repo, 'lib', 'value.js'), 'export const value = 2;\n');
    git('add', 'lib/value.js');
    git('commit', '-q', '-m', 'test: edit reached value');
    if (composition) {
      const afterComposition = await testActionKeys(repo, { files: ['test/probe.test.js', 'test/stable.test.js'] });
      assert.equal(afterComposition.get('test/stable.test.js').inputKey, beforeComposition.get('test/stable.test.js').inputKey, 'the unchanged file retains its input identity');
      const rows = selectedTestResults(testResultStore(repo), [afterComposition.get('test/stable.test.js').inputKey]);
      assert.ok(rows.some(row => row.origin.completion?.id === first.executionReceipt.id), JSON.stringify(rows));
    }
    const changed = await run(homeB, `${HOST}-setup`, 'land');
    assert.equal(changed.isGreen, true, changed.output);
    assert.match(changed.output, new RegExp(EXECUTED), 'editing a reached module executes its file again');
    if (composition) {
      assert.doesNotMatch(changed.output, /EXECUTED-STABLE/u, 'a companion changes only the reached probe closure');
      assert.match(changed.output, /^# reused .*\(test\/stable\.test\.js\)$/mu);
      assert.notEqual(changed.executionSource.tree, first.executionSource.tree);
    } else assert.doesNotMatch(changed.output, /^# reused /mu);
    const pushed = await run(homeA, HOST, 'push');
    assert.equal(pushed.isGreen, true, pushed.output);
    assert.doesNotMatch(pushed.output, new RegExp(EXECUTED));
    assert.match(pushed.output, /^# reused [0-9a-f]{64} from land /mu, 'the result crosses back to the first machine and another stage');
    if (composition) {
      const harnessPath = join(repo, 'packages/gate/src/io/test/action/reporter.js');
      writeFileSync(harnessPath, readFileSync(harnessPath, 'utf8') + '\n// fixture: changed actual harness input\n');
      git('add', 'packages/gate/src/io/test/action/reporter.js');
      git('commit', '-q', '-m', 'test: change actual harness bytes');
      const harnessChanged = await run(homeA, HOST, 'land');
      assert.equal(harnessChanged.isGreen, true, harnessChanged.output);
      assert.match(harnessChanged.output, new RegExp(EXECUTED));
      assert.match(harnessChanged.output, /EXECUTED-STABLE/u);
      assert.doesNotMatch(harnessChanged.output, /^# reused /mu, 'changed real harness invalidates both file receipts');
    }
    writeFileSync(join(repo, 'lib', 'value.js'), 'export const value = -1;\n');
    git('add', 'lib/value.js');
    git('commit', '-q', '-m', 'test: make reached value fail');
    for (const [home, host] of [[homeA, HOST], [homeB, `${HOST}-setup`]]) {
      const red = await run(home, host, 'audit');
      assert.equal(red.isGreen, false, red.output);
      assert.match(red.output, new RegExp(EXECUTED), 'a red receipt never supplies a cached passing execution');
      assert.doesNotMatch(red.output, /^# reused .*\(test\/probe\.test\.js\)$/mu);
    }
  } finally {
    for (const key of changedEnv) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
