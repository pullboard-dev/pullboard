/** @pullboard-test-input test-tree */
/** @pullboard-world-pin reads the shipped operation-entries baseline and source tree, and runs the check on fixture repos. */
/** The operation registry names one entry point per operation; a second is refused and the count may only fall [C7,#5846]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '../../../src/io/static/operations.js';
import { operationSites } from '../../../src/io/static/operations.js';
import { operationReport } from '../../../src/io/static/operations.js';
import { operationEntryGrowth } from '../../../src/io/static/operations.js';
import { operationEntryCounts } from '../../../src/io/static/operations.js';
import { operationRatchetGrowth } from '../../../src/io/static/operations.js';
import { tightenOperationBaseline } from '../../../src/io/static/operations.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

const ROOT = new URL('../../../../..', import.meta.url);
const BASELINE = 'packages/gate/data/baselines/operation-entries.json';
const RUNNER_SPAWN = "import { spawnSync } from 'node:child_process';\nexport const run = () => spawnSync(process.execPath, ['--test', 'a.test.js']);\n";

/** Run git in a fixture repository with a fixed identity. */
function git(cwd, args) {
  runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd });
}

test('#5846 clause 1: the registry names one entry point for each of the six operations [C7]', () => {
  assert.deepEqual(OPERATIONS.map(row => row.name), ['run-tests', 'dispatch-gates', 'landing', 'record-proof', 'start-daemons', 'fetch-runner-code']);
  for (const { entry } of OPERATIONS) assert.ok(readFileSync(new URL(entry, ROOT), 'utf8').length > 0, `${entry} exists`);
});

test('#5846 clause 1: a second spawn of the test runner outside the registered entry is refused; the entry, a comment and a test file are not sites [C7]', () => {
  const sites = operationSites(RUNNER_SPAWN, 'packages/demo/src/io/runner.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['run-tests', 2]]);
  assert.match(sites[0].text, /outside packages\/gate\/src\/io\/run-tests\.js/u);
  assert.deepEqual(operationEntryGrowth(sites, {}), sites, 'a file the baseline does not name is refused');
  assert.deepEqual(operationEntryGrowth(sites, { 'run-tests': ['packages/demo/src/io/runner.js'] }), [], 'a recorded second path is allowed until it goes');
  assert.deepEqual(operationSites(RUNNER_SPAWN, 'packages/gate/src/io/run-tests.js'), [], 'the registered entry is not a second path');
  assert.deepEqual(operationSites(`// ${RUNNER_SPAWN.split('\n')[1]}\n`, 'packages/demo/src/io/runner.js'), [], 'a commented-out spawn is not a site');
  assert.deepEqual(operationSites(RUNNER_SPAWN, 'packages/demo/tests/runner.test.js'), [], 'tests are not shipped source');
  assert.deepEqual(operationSites("spawnSync('git', ['status']);\n", 'packages/demo/src/io/git.js'), [], 'a child that is not the test runner is not a site');
});

test('#5923 clause 1: a template-string script whose comment names the runner and spawns another command has no run-tests site [C7]', () => {
  const script = "import { spawnSync } from 'node:child_process';\nconst script = `\n/** Runs bin/run-tests.js is not what this does. */\nspawnSync('git', ['status']);\n// node bin/run-tests.js\n`;\n";
  assert.deepEqual(operationSites(script, 'packages/demo/src/io/script.js'), [], 'a comment inside a template is prose');
});

test('#5923 clause 2: a file that spawns the runner script is still a site, even beside a template comment [C7]', () => {
  const real = "import { spawnSync } from 'node:child_process';\nconst note = `\n// bin/run-tests.js\n`;\nexport const run = () => spawnSync(process.execPath, ['bin/run-tests.js', 'a.test.js']);\n";
  assert.deepEqual(operationSites(real, 'packages/demo/src/io/runner.js').map(row => [row.operation, row.line]), [['run-tests', 5]]);
  assert.equal(operationSites(RUNNER_SPAWN, 'packages/demo/src/io/runner.js').length, 1);
});

test('#5846 clause 1: the repository has no second entry point the baseline does not name [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(operationEntryGrowth(operationReport(fileURLToPath(ROOT)), baseline), []);
});

test('#5846 clause 1: the registered tree check refuses a new test-runner spawn in a fixture repository [C7]', t => {
  const check = STATIC_TREE_CHECKS.find(row => row.name === 'operation-entries');
  assert.ok(check, 'the operation-entries check is registered');
  const tree = privateFixtureFiles('pb-operations-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  tree.write(BASELINE, JSON.stringify({ 'run-tests': [] }) + '\n');
  assert.deepEqual(check.run(tree.root), [], 'a tree with no second entry point passes');
  tree.write('packages/demo/src/io/runner.js', RUNNER_SPAWN);
  assert.match(check.run(tree.root)[0] ?? '', /^packages\/demo\/src\/io\/runner\.js:2: spawns the test runner outside/u);
});

test('#5846 clause 2: the entry-point count may only fall; a baseline row main did not allow is refused and the updater only lowers [C7]', t => {
  const main = { 'run-tests': ['packages/a/src/x.js', 'packages/a/src/y.js'] };
  assert.equal(operationEntryCounts(main)['run-tests'], 3);
  assert.equal(operationEntryCounts({ 'run-tests': ['packages/a/src/x.js'] })['run-tests'], 2);
  assert.deepEqual(operationRatchetGrowth({ 'run-tests': ['packages/a/src/x.js'] }, main), [], 'a fall passes');
  assert.match(operationRatchetGrowth({ 'run-tests': [...main['run-tests'], 'packages/a/src/z.js'] }, main)[0]?.text ?? '', /may only fall/u);
  assert.deepEqual(operationRatchetGrowth({ 'run-tests': ['packages/b/src/new.js'] }, main).length, 1, 'a swap is a new entry even at the same count');
  const spawn = operationSites(RUNNER_SPAWN, 'packages/a/src/x.js');
  assert.deepEqual(tightenOperationBaseline(spawn, main)['run-tests'], ['packages/a/src/x.js'], 'the updater drops what went');
  assert.throws(() => tightenOperationBaseline(operationSites(RUNNER_SPAWN, 'packages/a/src/new.js'), main), /new\.js:2:/u);

  const check = STATIC_TREE_CHECKS.find(row => row.name === 'operation-entries');
  const tree = privateFixtureFiles('pb-operations-ratchet-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  git(tree.root, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  tree.write(BASELINE, JSON.stringify({ 'run-tests': ['packages/demo/src/io/old.js'] }) + '\n');
  git(tree.root, ['add', '-A']);
  git(tree.root, ['commit', '-q', '-m', 'main']);
  git(tree.root, ['checkout', '-q', '-b', 'item']);
  tree.write('packages/demo/src/io/runner.js', RUNNER_SPAWN);
  tree.write(BASELINE, JSON.stringify({ 'run-tests': ['packages/demo/src/io/old.js', 'packages/demo/src/io/runner.js'] }) + '\n');
  assert.match(check.run(tree.root).join('\n'), /operation-entries\.json:1: run-tests gains a second entry point packages\/demo\/src\/io\/runner\.js/u,
    'recording the new spawn in the baseline is refused against main');
});
