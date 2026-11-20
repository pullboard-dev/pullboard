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
import { operationEntryFiles } from '../../../src/io/static/operations.js';
import { operationEntryCounts } from '../../../src/io/static/operations.js';
import { operationRatchetGrowth } from '../../../src/io/static/operations.js';
import { tightenOperationBaseline } from '../../../src/io/static/operations.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { walk } from '../../../src/io/scan.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

const ROOT = new URL('../../../../..', import.meta.url);
const BASELINE = 'packages/gate/data/baselines/operation-entries.json';
const RUNNER_SPAWN = "import { spawnSync } from 'node:child_process';\nexport const run = () => spawnSync(process.execPath, ['--test', 'a.test.js']);\n";

/** Run git in a fixture repository with a fixed identity. */
function git(cwd, args) {
  runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd });
}

test('gate.io-static-operations.case-5846-clause-1-the-registry-names: #5846 clause 1: the registry names one entry point for each operation [C7]', () => {
  assert.deepEqual(OPERATIONS.map(row => row.name), ['run-tests', 'dispatch-gates', 'execute-gate', 'landing', 'record-proof', 'start-daemons', 'fetch-runner-code', 'create-worktree', 'stop-process-tree', 'sync-sleep', 'move-trunk', 'write-state-file']);
  for (const { entry } of OPERATIONS) assert.ok(readFileSync(new URL(entry, ROOT), 'utf8').length > 0, `${entry} exists`);
});

test('gate.io-static-operations.case-5846-clause-1-a-second-spawn: #5846 clause 1: a second spawn of the test runner outside the registered entry is refused; the entry, a comment and a test file are not sites [C7]', () => {
  const sites = operationSites(RUNNER_SPAWN, 'packages/demo/src/io/runner.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['run-tests', 2]]);
  assert.match(sites[0].text, /outside apps\/cli\/src\/io\/run\/tests\.js/u);
  assert.deepEqual(operationEntryGrowth(sites, {}), sites, 'a file the baseline does not name is refused');
  assert.deepEqual(operationEntryGrowth(sites, { 'run-tests': ['packages/demo/src/io/runner.js'] }), [], 'a recorded second path is allowed until it goes');
  assert.deepEqual(operationSites(RUNNER_SPAWN, 'apps/cli/src/io/run/tests.js'), [], 'the registered entry is not a second path');
  assert.deepEqual(operationSites(`// ${RUNNER_SPAWN.split('\n')[1]}\n`, 'packages/demo/src/io/runner.js'), [], 'a commented-out spawn is not a site');
  assert.deepEqual(operationSites(RUNNER_SPAWN, 'packages/demo/tests/runner.test.js'), [], 'tests are not shipped source');
  assert.deepEqual(operationSites("spawnSync('git', ['status']);\n", 'packages/demo/src/io/git.js'), [], 'a child that is not the test runner is not a site');
});

test('gate.io-static-operations.case-5923-clause-1-a-template-string: #5923 clause 1: a template-string script whose comment names the runner and spawns another command has no run-tests site [C7]', () => {
  const script = "import { spawnSync } from 'node:child_process';\nconst script = `\n/** Runs bin/run-tests.js is not what this does. */\nspawnSync('git', ['status']);\n// node bin/run-tests.js\n`;\n";
  assert.deepEqual(operationSites(script, 'packages/demo/src/io/script.js'), [], 'a comment inside a template is prose');
});

test('gate.io-static-operations.case-5923-clause-2-a-file-that: #5923 clause 2: a file that spawns the runner script is still a site, even beside a template comment [C7]', () => {
  const real = "import { spawnSync } from 'node:child_process';\nconst note = `\n// bin/run-tests.js\n`;\nexport const run = () => spawnSync(process.execPath, ['bin/run-tests.js', 'a.test.js']);\n";
  assert.deepEqual(operationSites(real, 'packages/demo/src/io/runner.js').map(row => [row.operation, row.line]), [['run-tests', 5]]);
  assert.equal(operationSites(RUNNER_SPAWN, 'packages/demo/src/io/runner.js').length, 1);
});

test('gate.io-static-operations.case-5846-clause-1-the-repository-has: #5846 clause 1: the repository has no second entry point the baseline does not name [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(operationEntryGrowth(operationReport(fileURLToPath(ROOT)), baseline), []);
});

test('gate.io-static-operations.case-5846-clause-1-the-registered-tree: #5846 clause 1: the registered tree check refuses a new test-runner spawn in a fixture repository [C7]', t => {
  const check = STATIC_TREE_CHECKS.find(row => row.name === 'operation-entries');
  assert.ok(check, 'the operation-entries check is registered');
  const tree = privateFixtureFiles('pb-operations-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  tree.write(BASELINE, JSON.stringify({ 'run-tests': [] }) + '\n');
  assert.deepEqual(check.run(tree.root), [], 'a tree with no second entry point passes');
  tree.write('packages/demo/src/io/runner.js', RUNNER_SPAWN);
  assert.match(check.run(tree.root)[0] ?? '', /^packages\/demo\/src\/io\/runner\.js:2: spawns the test runner outside/u);
});

test('gate.io-static-operations.case-5846-clause-2-the-entry-point: #5846 clause 2: the entry-point count may only fall; a baseline row main did not allow is refused and the updater only lowers [C7]', t => {
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

const ADD_TREE = "export const make = (git, path) => git(['worktree', 'add', '--detach', path]);\n";

test('gate.io-static-operations.case-6750-clause-1-create-worktree-has: #6750 clause 1: create-worktree has one entry point, and a new git worktree add outside it fails the registry test [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'create-worktree');
  assert.equal(entry?.entry, 'packages/git/src/io/worktree.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export function addWorktree/u);
  const sites = operationSites(ADD_TREE, 'packages/demo/src/io/tree.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['create-worktree', 1]]);
  assert.deepEqual(operationEntryGrowth(sites, JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'))), sites, 'a new file is refused');
  assert.deepEqual(operationSites(ADD_TREE, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationSites("export const list = git => git(['worktree', 'list']);\n", 'packages/demo/src/io/tree.js'), [], 'worktree list is not a creation');
});

test('gate.io-static-operations.case-6750-clause-2-the-baseline-lists: #6750 clause 2: the baseline lists the 16 current worktree-add files as known violations, and the list can only shrink [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.equal(baseline['create-worktree'].length, 16);
  assert.deepEqual(baseline['create-worktree'], operationEntryFiles(operationReport(fileURLToPath(ROOT)))['create-worktree']);
  const grown = { ...baseline, 'create-worktree': [...baseline['create-worktree'], 'packages/demo/src/io/tree.js'] };
  assert.match(operationRatchetGrowth(grown, baseline)[0]?.text ?? '', /create-worktree gains a second entry point/u);
});

const KILL_GROUP = "export const stop = pid => process.kill(-pid, 'SIGTERM');\n";

test('gate.io-static-operations.case-6751-clause-1-stop-process-tree: #6751 clause 1: stop-process-tree is entered in packages/jobs, and a new process.kill(-pid) outside it fails the registry test [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'stop-process-tree');
  assert.equal(entry?.entry, 'packages/jobs/src/io/launch.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export function stopProcessTree/u);
  const sites = operationSites(KILL_GROUP, 'packages/demo/src/io/stop.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['stop-process-tree', 1]]);
  assert.deepEqual(operationEntryGrowth(sites, JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'))), sites, 'a new file is refused');
  assert.deepEqual(operationSites(KILL_GROUP, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationSites("export const stop = pid => process.kill(pid, 'SIGTERM');\n", 'packages/demo/src/io/stop.js'), [], 'a single-process kill is not a tree stop');
});

test('gate.io-static-operations.case-6751-clause-2-the-baseline-lists: #6751 clause 2: the baseline lists the current process-group kill files as known violations, and the list can only shrink [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(baseline['stop-process-tree'], operationEntryFiles(operationReport(fileURLToPath(ROOT)))['stop-process-tree']);
  assert.ok(baseline['stop-process-tree'].length > 0);
  const grown = { ...baseline, 'stop-process-tree': [...baseline['stop-process-tree'], 'packages/demo/src/io/stop.js'] };
  assert.match(operationRatchetGrowth(grown, baseline)[0]?.text ?? '', /stop-process-tree gains a second entry point/u);
});

test('gate.io-static-operations.case-6748-clause-1-run-tests-is: #6748 clause 1: run-tests is entered at the shim the launcher spawns, and the registry refuses another entry [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'run-tests');
  assert.equal(entry?.entry, 'apps/cli/src/io/run/tests.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /startRunTests\(/u, 'the entry launches the engine');
  assert.deepEqual(operationSites(RUNNER_SPAWN, 'packages/gate/src/io/run-tests.js').map(row => row.operation), ['run-tests'], 'any file but the shim that spawns the runner is a second path');
  assert.deepEqual(operationSites(RUNNER_SPAWN, entry.entry), [], 'the shim itself is not');
});

test('gate.io-static-operations.case-6748-clause-2-the-baseline-records: #6748 clause 2: the baseline records the shim and the bin forwarder as thin forwards, so the 4 names count as 1 operation [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(baseline.forwards['run-tests'], ['apps/cli/src/io/run/tests.js', 'packages/gate/bin/run-tests.js']);
  for (const path of baseline.forwards['run-tests']) assert.ok(readFileSync(new URL(path, ROOT), 'utf8').split('\n').length < 20, `${path} only forwards`);
  assert.equal(operationEntryCounts(baseline)['run-tests'], 1 + baseline['run-tests'].length, 'forwards add no entry point');
  assert.deepEqual(baseline.forwards, operationEntryFiles(operationReport(fileURLToPath(ROOT))).forwards, 'the recorded forwards are the registry\'s');
});

const RUN_GATE = "export async function runNewGate(root) { return root; }\n";

test('gate.io-static-operations.case-6749-clause-1-no-two-exported: #6749 clause 1: no two exported functions in the repository are both named runGate [C7]', () => {
  const owners = walk(fileURLToPath(ROOT), /^(?:apps|packages)\/[^/]+\/(?:src|bin)\/(?:.*\/)?[^/]+\.[cm]?js$/u)
    .filter(path => /export\s+(?:async\s+)?function\s+runGate\s*\(/u.test(readFileSync(new URL(path, ROOT), 'utf8')));
  assert.deepEqual(owners, ['packages/gate/src/io/execution.js'], 'only the gate executor is named runGate');
});

test('gate.io-static-operations.case-6749-clause-2-execute-gate-is: #6749 clause 2: execute-gate is its own operation and a new unmarked run*Gate function fails the registry test [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'execute-gate');
  assert.equal(entry?.entry, 'packages/gate/src/io/execution.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export async function runGate\(/u);
  assert.notEqual(OPERATIONS.find(row => row.name === 'dispatch-gates').entry, entry.entry, 'dispatch is a separate operation');
  const sites = operationSites(RUN_GATE, 'packages/demo/src/io/gate.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['execute-gate', 1]]);
  assert.deepEqual(operationEntryGrowth(sites, JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'))), sites, 'a new gate runner is refused');
  assert.deepEqual(operationSites(RUN_GATE, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationSites("export function dispatchGate() {}\n", 'packages/demo/src/io/gate.js').map(row => row.operation), ['dispatch-gates'], 'a dispatcher is not an executor');
});

const SLEEP_WAIT = 'export const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n';

test('gate.io-static-operations.case-6752-clause-1-sync-sleep-is: #6752 clause 1: sync-sleep is entered at the kernel sleepBlocking function, and a new Atomics.wait outside it fails the registry test [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'sync-sleep');
  assert.equal(entry?.entry, 'packages/kernel/src/logic/sleep.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export function sleepBlocking/u);
  const sites = operationSites(SLEEP_WAIT, 'packages/demo/src/io/nap.js');
  assert.deepEqual(sites.map(row => [row.operation, row.line]), [['sync-sleep', 1]]);
  assert.deepEqual(operationEntryGrowth(sites, JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'))), sites, 'a new file is refused');
  assert.deepEqual(operationSites(SLEEP_WAIT, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationSites(`// ${SLEEP_WAIT}`, 'packages/demo/src/io/nap.js'), [], 'a commented-out wait is not a site');
});

test('gate.io-static-operations.case-6752-clause-2-the-baseline-lists: #6752 clause 2: the baseline lists the current Atomics.wait files as known violations, and the list can only shrink [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(baseline['sync-sleep'], operationEntryFiles(operationReport(fileURLToPath(ROOT)))['sync-sleep']);
  assert.ok(baseline['sync-sleep'].length > 0);
  assert.equal(operationEntryCounts(baseline)['sync-sleep'], 1 + baseline['sync-sleep'].length);
  const grown = { ...baseline, 'sync-sleep': [...baseline['sync-sleep'], 'packages/demo/src/io/nap.js'] };
  assert.match(operationRatchetGrowth(grown, baseline)[0]?.text ?? '', /sync-sleep gains a second entry point/u);
});

const MOVE_REF = "export const move = (git, trunk, tip) => git(['update-ref', trunk, tip]);\n";
const PUSH_MAIN = "export const push = (git, remote, entry) => git(['push', remote, `+${entry.commit}:${entry.ref}`]);\n";

test('gate.io-static-operations.case-6747-clause-1-move-trunk-marks: #6747 clause 1: move-trunk marks an update-ref of a trunk ref and a push to main, entered at publish.js [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'move-trunk');
  assert.equal(entry?.entry, 'packages/landing/src/io/step/publish.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export async function moveTrunkRef/u);
  assert.deepEqual(operationSites(MOVE_REF, 'packages/demo/src/io/move.js').map(row => [row.operation, row.line]), [['move-trunk', 1]]);
  assert.deepEqual(operationSites(PUSH_MAIN, 'packages/demo/src/io/push.js').map(row => [row.operation, row.line]), [['move-trunk', 1]]);
  assert.deepEqual(operationSites("git(['update-ref', 'refs/heads/main', tip]);\n", 'packages/demo/src/io/move.js').length, 1, 'a literal main ref counts');
  assert.deepEqual(operationSites("git(['update-ref', `refs/pullboard/x/${id}`, tip]);\n", 'packages/demo/src/io/pin.js'), [], 'a pin is not a trunk move');
  assert.deepEqual(operationSites(MOVE_REF, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationEntryGrowth(operationSites(MOVE_REF, 'packages/demo/src/io/move.js'), JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'))).length, 1, 'a new file is refused');
});

test('gate.io-static-operations.case-6747-clause-2-the-baseline-lists: #6747 clause 2: the baseline lists the other trunk movers as known violations, and the list can only shrink [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(baseline['move-trunk'], operationEntryFiles(operationReport(fileURLToPath(ROOT)))['move-trunk']);
  assert.equal(baseline['move-trunk'].length, 7, 'measured: 7 other files, the bar said 6');
  const grown = { ...baseline, 'move-trunk': [...baseline['move-trunk'], 'packages/demo/src/io/move.js'] };
  assert.match(operationRatchetGrowth(grown, baseline)[0]?.text ?? '', /move-trunk gains a second entry point/u);
});

test('gate.io-static-operations.case-8055-the-mutation-adapter-is-the: #8055 [C7]: the mutation adapter is the one named spawner of tests outside the run-tests entry, and no other file is', () => {
  const code = "import { execFile } from 'node:child_process';\nexecFile(process.execPath, ['--test', 'a.test.js']);\n";
  assert.deepEqual(operationSites(code, 'packages/sandbox/src/io/mutate.js'), []);
  assert.equal(operationSites(code, 'packages/sandbox/src/io/other.js').length, 1);
});

const WRITE_RENAME = "import { renameSync, writeFileSync } from 'node:fs';\nexport function save(file, text) {\n  writeFileSync(`${file}.tmp`, text);\n  renameSync(`${file}.tmp`, file);\n}\n";

test('gate.io-static-operations.case-6740-clause-2-write-state-file: #6740 clause 2: write-state-file is entered at the store writeFileAtomic, and a private write-then-rename outside it is a known violation [C7]', () => {
  const entry = OPERATIONS.find(row => row.name === 'write-state-file');
  assert.equal(entry?.entry, 'packages/store/src/io/atomic.js');
  assert.match(readFileSync(new URL(entry.entry, ROOT), 'utf8'), /export function writeFileAtomic/u);
  assert.deepEqual(operationSites(WRITE_RENAME, 'packages/demo/src/io/save.js').map(row => [row.operation, row.line]), [['write-state-file', 3]]);
  assert.deepEqual(operationSites(WRITE_RENAME, entry.entry), [], 'the entry itself is not a second path');
  assert.deepEqual(operationSites("import { renameSync } from 'node:fs';\nrenameSync(a, b);\n", 'packages/demo/src/io/move.js'), [], 'a rename with no write is not a state-file write');
  assert.deepEqual(operationSites(`// ${WRITE_RENAME.split('\n')[2].trim()}\n// renameSync(a, b);\n`, 'packages/demo/src/io/save.js'), [], 'a comment is not a site');
  assert.deepEqual(operationSites(WRITE_RENAME, 'packages/demo/tests/save.test.js'), [], 'tests are not shipped source');
});

test('gate.io-static-operations.case-6740-clause-2-the-baseline-records: #6740 clause 2: the baseline records every private write-then-rename as a known violation, and the list can only shrink [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL(BASELINE, ROOT), 'utf8'));
  assert.deepEqual(baseline['write-state-file'], operationEntryFiles(operationReport(fileURLToPath(ROOT)))['write-state-file']);
  assert.equal(baseline['write-state-file'].length, 80, 'measured: 89 private helpers at claim, 5 added and 6 removed on main since (publishCacheEntry in codemap, #9883 removes it; setup.js, prune.js, compaction.js and diagnostics.js now write through the fs adapter and no longer match the write-then-rename scan), cleanup.js writes owner-only through the adapter open/write/close and no longer matches the scan, activity inbox.js and observations.js rename through the adapter and no longer match the scan, init/finish.js, memo.js and the pinned tool build.js no longer match the scan, cap.js loses its write helpers (#11330), inventory.js renames through the fs adapter and no longer matches the scan, the bar said 59');
  const grown = { ...baseline, 'write-state-file': [...baseline['write-state-file'], 'packages/demo/src/io/save.js'] };
  assert.match(operationRatchetGrowth(grown, baseline)[0]?.text ?? '', /write-state-file gains a second entry point/u);
  const { 'write-state-file': recorded, ...before } = baseline;
  assert.ok(recorded.length > 0);
  assert.deepEqual(operationRatchetGrowth(baseline, before), [], 'an operation main does not list yet is a first record, not growth');
});
