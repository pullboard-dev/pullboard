/** Explicit engine stays preserve canonical source authority through the real submit controller [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { computePlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { retainEnginePaths } from '../bin/cells-engine-stays.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { withMainCheckout } from '../src/main-red.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { withImportParseCache } from '../src/module-import-cache.js';
import { foreignNodeOptions } from '../src/test-isolation.js';

/** Pin actual accepted source and complete lint authority before a candidate requests engine stays. */
function accepted(t) {
  const box = fixture(t);
  const paths = ['src/sample-engine.js', 'src/engine-next.js', 'src/engine-numbers.js', 'src/ordinary.js',
    'src/misleading-engine.js', 'src/forwarded-engine.js'];
  box.put(paths[0], 'export const SAMPLE_ENGINE = 17;\n');
  box.put(paths[1], 'export function unassignedEngine() { return 18; }\n');
  box.put(paths[2], 'export function nextEngineNumber() { return 18; }\n');
  box.put(paths[3], 'export function ordinary() { return 1; }\n');
  box.put(paths[4], 'export function ordinaryEngine() { return 1; }\n');
  box.put(paths[5], "export { SAMPLE_ENGINE } from './sample-engine.js';\n");
  const seed = JSON.parse(readFileSync(join(box.root, 'bin/cells-plan/seed.json'), 'utf8'));
  seed.order.splice(1, 0, 'state');
  seed.cells.state = paths;
  box.put('bin/cells-plan/seed.json', JSON.stringify(seed));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted engine source');
  const plan = computePlan(box.root);
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted state placements');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'seed accepted lint baseline');
  const complete = cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn }));
  rmSync(join(box.root, 'bin/cell-lint-baselines'), { recursive: true });
  writeCellLintBaseline(box.root, complete, { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'accepted complete baseline');
  return { ...box, plan, paths, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/** Evaluate committed candidate metadata through the immutable controller, never a candidate evaluator. */
async function inspect(box) {
  writePlan(box.root, box.plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate explicit engine stays');
  return await requireSubmitCells(box.root, box.main, git(box.root, 'rev-parse', 'HEAD').trim(),
    { item_frozen: JSON.stringify({ criterion: 'Retain listed engine identities and the two approved bootstrap support leaves.' }) },
    { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
      readCutItems: () => [], cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
}

test('listed canonical engine leaves and the two bootstrap supports stay without changing source [C7,CD64]', async t => {
  const box = accepted(t), paths = box.paths.slice(0, 3);
  const original = paths.map(file => readFileSync(join(box.root, file), 'utf8'));
  box.plan = retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'state', paths, pathMap: new Map() });
  assert.deepEqual(box.plan.engineStays.map(entry => entry.row[0]), paths);
  assert.deepEqual(paths.map(file => readFileSync(join(box.root, file), 'utf8')), original);
  assert.deepEqual((await inspect(box)).problems, []);
});

test('an unlisted ordinary placement cannot disappear through a stay or forged engine provenance [C7,CD64]', async t => {
  const box = accepted(t), file = box.paths[3];
  assert.throws(() => retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'state', paths: [file], pathMap: new Map() }),
    error => error.code === 'CELLS_ENGINE_STAY');
  const cell = box.plan.cells.find(value => value.name === 'state');
  const row = cell.paths.find(value => value[0] === file);
  cell.paths = cell.paths.filter(value => value[0] !== file);
  cell.reexports = cell.reexports.filter(value => value !== file);
  box.plan.stays.push({ path: file, reason: 'canonical engine identity retained in src during package moves' });
  await assert.rejects(inspect(box), /accepted row src\/ordinary.js disappeared/u);
  box.plan.engineStays = [{ cell: 'state', row }];
  await assert.rejects(inspect(box), /unproven canonical engine stay: src\/ordinary.js/u);
});

test('candidate edits cannot manufacture engine stay authority from accepted ordinary source [C7,CD64]', async t => {
  const box = accepted(t), file = box.paths[3], cell = box.plan.cells.find(value => value.name === 'state');
  const row = cell.paths.find(value => value[0] === file);
  cell.paths = cell.paths.filter(value => value[0] !== file);
  cell.reexports = cell.reexports.filter(value => value !== file);
  box.plan.stays.push({ path: file, reason: 'canonical engine identity retained in src during package moves' });
  box.plan.engineStays = [{ cell: 'state', row }];
  box.put(file, 'export const MANUFACTURED_ENGINE = 99;\n');
  await assert.rejects(inspect(box), /unproven canonical engine stay: src\/ordinary.js/u);
});

test('an engine-looking filename or imported engine export cannot manufacture declaration authority [C7,CD64]', async t => {
  const box = accepted(t), cell = box.plan.cells.find(value => value.name === 'state');
  box.plan.engineStays = [];
  for (const file of box.paths.slice(4)) {
    assert.throws(() => retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'state', paths: [file], pathMap: new Map() }),
      error => error.code === 'CELLS_ENGINE_STAY');
    const row = cell.paths.find(value => value[0] === file);
    cell.paths = cell.paths.filter(value => value[0] !== file);
    cell.reexports = cell.reexports.filter(value => value !== file);
    box.plan.stays.push({ path: file, reason: 'canonical engine identity retained in src during package moves' });
    box.plan.engineStays.push({ cell: 'state', row });
  }
  await assert.rejects(inspect(box), error => box.paths.slice(4)
    .every(file => error.message.includes(`unproven canonical engine stay: ${file}`)));
});
