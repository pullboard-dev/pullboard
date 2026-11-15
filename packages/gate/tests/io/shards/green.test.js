/** @pullboard-test-input source-tree */
/** A builder's green pullboard test run is the gate's proof of the same files at the same tree, and nothing else [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { plainCheckRun } from '../../../src/io/shards/green.js';
import { recordGreenRun } from '../../../src/io/shards/green.js';
import { reusableGreenRun } from '../../../src/io/shards/green.js';
import { reusableProof } from '../../../src/io/shards/green.js';
import { writeFileSync } from 'node:fs';
import { runFixtureGit } from '../../fixtures/child.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../../apps/cli/tests/fixtures/testkit.js';

const RUNNER = 'node packages/gate/src/io/run/tests.js';
const FILE = 'test/one.test.js';
const TOOLING = 'a'.repeat(64);
const TIMING = '11111111-2222-4333-8444-555555555555';

/** A real repository (no commit yet) beside a private machine home; `commit()` adds a commit and returns its commit and tree. */
function repository(t) {
  const { root: home } = privateFixtureFiles('pullboard-green-proof-');
  const repo = fixtureCommittedGraph('pullboard-green-repo-');
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const machine = join(home, 'machine');
  mkdirSync(machine);
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  let n = 0;
  const commit = () => {
    repo.put('source.txt', `source ${n++}\n`);
    const at = repo.commit();
    return { commit: at, tree: runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: repo.root, env }) };
  };
  return { root: repo.root, machine, env, commit, folder: join(machine, 'shard-passes') };
}

/** A runner's green run of `files` at a source, as runOnRunnerAsync returns it. */
function greenRun(source, { tooling = TOOLING, green = true } = {}) {
  return { isGreen: green, exitCode: green ? 0 : 1, output: `TAP version 13\nok 1 - one [C7]\n# timing ${TIMING}\n`, environment: { node: 'v22.22.2', platform: 'darwin', arch: 'arm64' },
    executionRunner: 'runner-a', executionSource: { commit: source.commit, tree: source.tree, tooling: { sha256: tooling } }, remoteWallMs: 64_000, seconds: 64 };
}

test('clause 2: only the same tree, the same files and the same runner tooling reuse a recorded green run [C7]', t => {
  const repo = repository(t);
  const first = repo.commit();
  const wanted = { tree: first.tree, head: first.commit, runner: RUNNER, files: [FILE], tooling: TOOLING, folder: repo.folder };
  assert.equal(recordGreenRun(greenRun(first), { runner: RUNNER, files: [FILE], timingRunId: TIMING, folder: repo.folder }), true);
  const reused = reusableGreenRun({ ...wanted, timingRunId: 'ffffffff-2222-4333-8444-555555555555' });
  assert.equal(reused.isGreen, true);
  assert.match(reused.output, /^# reused green run 11111111-2222-4333-8444-555555555555 of 1 file\(s\) at tree /u, 'the output names the run reused');
  assert.match(reused.output, /# timing ffffffff-2222-4333-8444-555555555555/u, 'the outcome frames are rebound to this run');
  assert.equal(reused.executionSource.tree, first.tree);
  const second = repo.commit();
  assert.equal(reusableGreenRun({ ...wanted, tree: second.tree, head: second.commit }), null, 'another tree runs again');
  assert.equal(reusableGreenRun({ ...wanted, files: [FILE, 'test/two.test.js'] }), null, 'another file set runs again');
  assert.equal(reusableGreenRun({ ...wanted, runner: 'node other/runner.js' }), null, 'another runner command runs again');
  assert.equal(reusableGreenRun({ ...wanted, tooling: 'b'.repeat(64) }), null, 'other runner tooling runs again');
  assert.equal(reusableGreenRun({ ...wanted, tooling: null }), null, 'unknown tooling runs again');
  assert.equal(recordGreenRun(greenRun(second, { green: false }), { runner: RUNNER, files: [FILE], folder: repo.folder }), false, 'a red is never recorded');
  assert.equal(recordGreenRun({ ...greenRun(second), executionSource: { commit: second.commit, tree: second.tree } }, { runner: RUNNER, files: [FILE], folder: repo.folder }), false,
    'a run without runner tooling is never recorded');
  assert.equal(reusableGreenRun({ ...wanted, tree: second.tree, head: second.commit }), null);
});

test('clause 2: only a plain runner command over test files is a check a recorded run can stand in for [C7]', () => {
  assert.deepEqual(plainCheckRun(`${RUNNER} ./${FILE}`), { runner: RUNNER, files: [FILE] });
  assert.equal(plainCheckRun(`${RUNNER} ${FILE} && rm -rf x`), null);
  assert.equal(plainCheckRun(`! ${RUNNER} ${FILE}`), null);
  assert.equal(plainCheckRun(`${RUNNER} --test-name-pattern=x ${FILE}`), null);
  assert.equal(plainCheckRun('test ! -e src/x.js'), null);
});

/** A builder's head that imports ./lib/helper.js, then a merge of a trunk commit changing only `touch`; the builder's green run is recorded. */
function mergedHead(t, touch) {
  const repo = repository(t);
  const git = (...args) => runFixtureGit(args, { cwd: repo.root, env: repo.env });
  const files = ['test/one.test.js', 'test/lib/helper.js', 'docs/other.txt'];
  git('config', 'user.email', 'a@example.test'); git('config', 'user.name', 'a');
  const put = (path, text) => { mkdirSync(join(repo.root, path, '..'), { recursive: true }); writeFileSync(join(repo.root, path), text); };
  put('test/one.test.js', "import { x } from './lib/helper.js';\n"); put('test/lib/helper.js', 'export const x = 1;\n'); put('docs/other.txt', 'a\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim(), base = git('rev-parse', 'HEAD').trim();
  put('source.txt', 'builder\n'); git('add', '-A'); git('commit', '-qm', 'builder');
  const built = { commit: git('rev-parse', 'HEAD').trim(), tree: git('rev-parse', 'HEAD^{tree}').trim() };
  git('checkout', '-q', '-b', 'trunk', base);
  put(touch, 'changed on trunk\n'); git('add', '-A'); git('commit', '-qm', 'trunk');
  git('checkout', '-q', branch);
  git('merge', '--no-ff', '-qm', 'merge main', 'trunk');
  const merged = { commit: git('rev-parse', 'HEAD').trim(), tree: git('rev-parse', 'HEAD^{tree}').trim() };
  const wanted = { tree: merged.tree, head: merged.commit, runner: RUNNER, files: ['test/one.test.js'], tooling: TOOLING, folder: repo.folder };
  assert.equal(recordGreenRun(greenRun(built), { runner: RUNNER, files: ['test/one.test.js'], timingRunId: TIMING, folder: repo.folder }), true);
  assert.equal(reusableGreenRun(wanted), null, 'the merged tree itself has no recorded run');
  return { wanted, root: repo.root, merged, files };
}

test('clause 1: a main merge that changes no file the check imports keeps the earlier green run [C7]', t => {
  const { wanted, root, merged } = mergedHead(t, 'docs/other.txt');
  const reused = reusableProof(root, wanted);
  assert.equal(reused?.isGreen, true);
  assert.equal(reused.executionSource.commit, merged.commit, 'the run is rebound to the merged head');
});

test('clause 2: a main merge that touches the test file or anything it imports reruns the check [C7]', t => {
  for (const touch of ['test/lib/helper.js', 'test/one.test.js']) {
    const { wanted, root } = mergedHead(t, touch);
    assert.equal(reusableProof(root, wanted), null, `${touch} is in the closure`);
  }
});
