/** @pullboard-test-input source-tree bin/cells-plan.json bin/cells-plan/** */
/** Process composition has explicit app ownership; ordinary libraries keep their real edges [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { placePath } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { checkCuts } from '../bin/cells-plan-cuts.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { runFixtureChild } from './fixture-child.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

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
      cell('app:lib', 2, [['src/native.js', 'apps/lib/src/core/native.js', 'rule']])],
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
  assert.ok(after.cells[1].paths.some(row => row[0] === path && row[1] === 'apps/lib/src/shell/entry.js'));
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
  const before = readFileSync(join(root, 'bin/cells-plan.json'), 'utf8');
  for (const source of [
    'export const library = true;\n',
    '// process.argv[1]\nexport const library = "process.send";\n',
    'export const library = () => process.argv;\n',
    'export function library() { if (process.argv[1]) return true; }\n',
    'const process = { argv: [] };\nif (process.argv[1]) console.log(process.argv);\n',
  ]) {
    put(path, source);
    assert.throws(() => placePath(root, path, { cell: 'app:lib', entry: true }), error => error.code === 'CELLS_ENTRY');
    assert.equal(readFileSync(join(root, 'bin/cells-plan.json'), 'utf8'), before, 'refusal publishes no placement');
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
  assert.throws(() => writePlan(root, plan), error => error.code === 'CELLS_ENTRY');
  assert.throws(() => placePath(root, 'src/native.js', { cell: 'low', entry: true }), error => error.code === 'CELLS_ENTRY');
});
