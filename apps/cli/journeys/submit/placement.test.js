/** @pullboard-test-input source-tree */
/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Process composition has explicit app ownership; ordinary libraries keep their real edges [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { placePath } from '../../../../packages/codemap/index.js';
import { cellReadPathMap } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { checkCuts } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { entryPlacementProblems } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { frontDoorBypasses } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { landedCutItemRows } from '../../index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';

const BIN = fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));

/** Keep a real tracked entry, provider and caller in a two-cell plan with no cut exceptions. */
function box(t, { bin = false } = {}) {
  const value = fixture(t), { root, put } = value;
  const path = bin ? 'bin/entry.js' : 'src/entry.js';
  const source = `import { native } from '${bin ? '../src/' : './'}native.js';\nimport { fileURLToPath } from 'node:url';\nif (process.argv[1] === fileURLToPath(import.meta.url)) native(process.argv.slice(2));\n`;
  put(path, source);
  put('src/native.js', 'export function native(args) { return args; }\n');
  git(root, 'add', '-A');
  /** A cell's complete row data is kept independent of the plan reader's derived counters. */
  const cell = (name, order, paths) => ({ name, order, kind: name.startsWith('app:') ? 'app' : 'package',
    root: name === 'low' ? 'packages/low' : 'apps/lib', frontDoor: name === 'low' ? 'packages/low/index.js' : 'apps/lib/index.js',
    paths, reexports: [], imports: [], cuts: [], ratchets: {}, item: { after: [] } });
  writePlan(root, { version: 1, base: git(root, 'rev-parse', 'HEAD').trim(),
    cells: [cell('low', 1, bin ? [] : [[path, 'packages/low/src/shell/entry.js', 'rule']]),
      cell('app:lib', 2, [['src/native.js', 'apps/lib/src/logic/native.js', 'rule']])],
    stays: bin ? [{ path, reason: 'the public executable stays in place' }] : [] });
  return { ...value, path, source };
}

test('a guarded process module leaves its old cell and keeps its exact body [C7,D3,CD64]', t => {
  const { root, path, source } = box(t);
  const before = readPlan(root);
  assert.ok(checkCuts(root, before, 'low', { allLaterCells: true }).some(problem => problem.includes('src/entry.js -> src/native.js')));
  placePath(root, path, { cell: 'app:lib', entry: true });
  const after = readPlan(root);
  assert.deepEqual(after.entries, [{ path, cell: 'app:lib' }]);
  assert.equal(after.cells[0].paths.length, 0);
  assert.ok(after.cells[1].paths.some(row => row[0] === path && row[1] === 'apps/lib/src/io/entry.js'));
  assert.equal(after.totals.movedPaths, before.totals.movedPaths);
  assert.deepEqual(checkCuts(root, after, 'low', { allLaterCells: true }), []);
  assert.deepEqual(checkCuts(root, after, 'app:lib', { allLaterCells: true }), []);
  assert.equal(readFileSync(join(root, path), 'utf8'), source, 'placement never rewrites or forwards the process body');
  for (const cell of after.cells) assert.deepEqual(cell.cuts, [], 'no exception is added');
});

test('the real --entry command owns a bin script without moving its public path [C7,D3,CD64]', t => {
  const { root, path, source } = box(t, { bin: true });
  const result = runFixtureChild(process.execPath, [BIN, '--place', path, '--cell', 'app:lib', '--entry'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = readPlan(root);
  assert.deepEqual(plan.entries, [{ path, cell: 'app:lib' }]);
  assert.equal(plan.stays.filter(row => row.path === path).length, 1);
  assert.equal(plan.cells.flatMap(cell => cell.paths).filter(row => row[0] === path).length, 0);
  assert.equal(readFileSync(join(root, path), 'utf8'), source);
  assert.deepEqual(checkCuts(root, plan, 'app:lib', { allLaterCells: true }), []);
  assert.throws(() => placePath(root, path, { cell: 'app:lib', entry: true }), error => error.code === 'CELLS_ENTRY');
});

test('a library cannot borrow process ownership from examples or callbacks [C7,D3,CD64]', t => {
  const { root, path, put } = box(t, { bin: true });
  const before = readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8');
  for (const source of [
    'export const library = true;\n',
    '// process.argv[1]\nexport const library = "process.send";\n',
    'export const library = () => process.argv;\n',
    'export function library() { if (process.argv[1]) return true; }\n',
    'const process = { argv: [] };\nif (process.argv[1]) console.log(process.argv);\n',
    '#!/usr/bin/env node\nconst argv = process.argv.slice(2);\nexport function parse() { return argv; }\n',
    '#!/usr/bin/env node\nconst argv = process.argv.slice(2);\n',
  ]) {
    put(path, source);
    assert.throws(() => placePath(root, path, { cell: 'app:lib', entry: true }), error => error.code === 'CELLS_ENTRY');
    assert.equal(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'), before, 'refusal publishes no placement');
  }
});

test('a module needs an own-file identity guard, not just process or URL mentions [C7,D3,CD64]', t => {
  const { root, path, put } = box(t);
  for (const condition of [
    'process.argv[1] && import.meta.url',
    'process.argv[1] !== fileURLToPath(import.meta.url)',
    'true || process.argv[1] === fileURLToPath(import.meta.url)',
    "process.argv[1] === fileURLToPath('file:///another-entry.js')",
  ]) {
    put(path, `import { fileURLToPath } from 'node:url';\nif (${condition}) console.log(process.argv);\n`);
    assert.throws(() => placePath(root, path, { cell: 'app:lib', entry: true }), error => error.code === 'CELLS_ENTRY');
  }
});

test('entry ownership never hides a lower caller importing the higher process root [C7,D3,CD64]', t => {
  const { root, path, put } = box(t, { bin: true });
  placePath(root, path, { cell: 'app:lib', entry: true });
  put('src/caller.js', "import '../bin/entry.js';\n");
  const plan = readPlan(root);
  plan.cells[0].paths.push(['src/caller.js', 'packages/low/src/shell/caller.js', 'rule']);
  writePlan(root, plan);
  const problems = checkCuts(root, readPlan(root), 'low', { allLaterCells: true });
  assert.ok(problems.some(problem => problem.includes('src/caller.js -> bin/entry.js')), problems.join('\n'));
});

test('stale or forged entry metadata cannot suppress a library edge [C7,D3,CD64]', t => {
  const { root, path, put } = box(t, { bin: true });
  placePath(root, path, { cell: 'app:lib', entry: true });
  const plan = readPlan(root);
  put(path, 'export const ordinaryLibrary = true;\n');
  assert.ok(checkCuts(root, plan, 'low', { allLaterCells: true }).some(problem => problem.includes('not a placed process entry')));
  assert.throws(() => frontDoorBypasses(root, plan, 'low'), error => error.code === 'CELLS_ENTRY');
  assert.throws(() => writePlan(root, plan), error => error.code === 'CELLS_ENTRY');
  assert.throws(() => placePath(root, 'src/native.js', { cell: 'low', entry: true }), error => error.code === 'CELLS_ENTRY');
});

/** Pin complete accepted rows and actual census authority before changing process ownership. */
function acceptedEntry(t, { declared = false } = {}) {
  const value = box(t), { root, path } = value, plan = readPlan(root);
  const known = new Set([...plan.stays.map(row => row.path), ...plan.cells.flatMap(cell => cell.paths.map(row => row[0]))]);
  for (const file of git(root, 'ls-files').trim().split('\n')) {
    if (/^(?:src|bin)\/.+\.js$/u.test(file) && !known.has(file)) plan.stays.push({ path: file, reason: 'unrelated private fixture source stays unchanged' });
  }
  writePlan(root, plan);
  if (declared) placePath(root, path, { cell: 'app:lib', entry: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'accepted process fixture');
  writeCellLintBaseline(root, cellLintBaseline(cellLintReport(root, { importsIn, commonJsIn })), { initialize: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'accepted baseline inventory');
  const complete = cellLintBaseline(cellLintReport(root, { importsIn, commonJsIn }));
  rmSync(join(root, 'packages/codemap/data/baselines/lints'), { recursive: true });
  writeCellLintBaseline(root, complete, { initialize: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'accepted complete entry baseline');
  return { ...value, main: git(root, 'rev-parse', 'HEAD').trim(), board: fixtureBoard(t) };
}

/** Run the real trusted controller over immutable commits, without trusting the placement writer. */
async function inspectEntry(value) {
  // The accepted-main inventory is produced by a background job on a runner; the test produces its own (a test never waits on one).
  await warmAcceptedCells(value.root, value.main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: value.main });
  git(value.root, 'add', '-A');
  git(value.root, 'commit', '-q', '--allow-empty', '-m', 'candidate process ownership');
  return requireSubmitCells(value.root, value.main, git(value.root, 'rev-parse', 'HEAD').trim(),
    { item_frozen: JSON.stringify({ criterion: 'Explicit source-validated process ownership only.' }) },
    { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
      readCutItems: () => landedCutItemRows(value.board.db), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
}

test('trusted submit admits an actual explicit process rehome and keeps its source binding [C7,D3,CD64]', async t => {
  const value = acceptedEntry(t);
  placePath(value.root, value.path, { cell: 'app:lib', entry: true });
  assert.deepEqual((await inspectEntry(value)).problems, []);
});

test('trusted submit refuses a library substituted after entry placement [C7,D3,CD64]', async t => {
  const value = acceptedEntry(t);
  placePath(value.root, value.path, { cell: 'app:lib', entry: true });
  value.put(value.path, 'export const library = true;\n');
  await assert.rejects(inspectEntry(value), /not a placed process entry/u);
});

test('trusted submit still refuses later relabeling without explicit entry authority [C7,D3,CD64]', async t => {
  const value = acceptedEntry(t);
  placePath(value.root, value.path, { cell: 'app:lib', entry: true });
  const plan = readPlan(value.root);
  delete plan.entries;
  writePlan(value.root, plan);
  await assert.rejects(inspectEntry(value), /was relabeled as later/u);
});

test('trusted submit preserves already accepted process ownership [C7,D3,CD64]', async t => {
  const value = acceptedEntry(t, { declared: true });
  const plan = readPlan(value.root);
  delete plan.entries;
  writePlan(value.root, plan);
  await assert.rejects(inspectEntry(value), /accepted process entry ownership changed/u);
});

test('clause 1: main\'s committed plan places every process entry, packages/landing/src/io/main/red/refresh.js included [C7]', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
  const plan = readPlan(root);
  const original = 'bin/main-red-refresh.js';
  assert.equal(cellReadPathMap(root).get(original), 'packages/landing/src/io/main/red/refresh.js');
  assert.ok(plan.stays.some(stay => stay.path === original));
  assert.ok(plan.entries.some(entry => entry.path === original));
  assert.deepEqual(entryPlacementProblems(root, plan), []);
});

test('clause 1: infra-release and main-red-focus engines live in the state engines folder, with no src/ stay left [C7,V4]', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
  const plan = readPlan(root);
  for (const name of ['infra-release-engine.js', 'main-red-focus-engine.js']) {
    assert.ok(existsSync(join(root, 'packages/state/src/logic/engines', name)), name);
    assert.equal(plan.stays.some(entry => entry.path === `src/${name}`), false, `no stay row names src/${name}`);
  }
  assert.deepEqual(entryPlacementProblems(root, plan), []);
});
