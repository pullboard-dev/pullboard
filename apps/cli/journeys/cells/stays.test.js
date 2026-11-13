/** Explicit engine stays preserve canonical source authority through the real submit controller [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { retainEnginePaths } from '../../../../packages/codemap/index.js';
import { engineStayTransition } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';

test('canonical metadata and move constants retain exact source authority [C7,CD64]', t => {
  const accepted = fixture(t), candidate = fixture(t);
  for (const file of ['packages/state/src/io/engine/metadata.js', 'packages/state/src/logic/move/constants.js']) {
    const row = [file, 'packages/state/relocated/' + file.split('/').at(-1), 'fixture'];
    const before = { cells: [{ name: 'state', root: 'packages/state', paths: [row] }], engineStays: [] };
    const after = { cells: [{ name: 'state', root: 'packages/state', paths: [] }],
      stays: [{ path: file, reason: 'canonical engine identity retained in src during package moves' }],
      engineStays: [{ cell: 'state', row }] };
    const check = () => engineStayTransition({ beforeRoot: accepted.root, afterRoot: candidate.root, before, after, afterMap: new Map() });
    accepted.put(file, 'export const value = 1;\n');
    candidate.put(file, 'export const value = 1;\n');
    assert.deepEqual(check().problems, [], `${file} retains the accepted source`);
    candidate.put(file, 'export const value = 2;\n');
    assert.ok(check().problems.includes(`unproven canonical engine stay: ${file}`), 'changed candidate bytes are refused');
    rmSync(join(candidate.root, file));
    symlinkSync(join(accepted.root, file), join(candidate.root, file));
    assert.ok(check().problems.includes(`unproven canonical engine stay: ${file}`), 'a symlink cannot attest source authority');
  }
});

/** Pin actual accepted source and complete lint authority before a candidate requests engine stays. */
function accepted(t, cellName = 'state') {
  const box = fixture(t);
  const paths = ['src/sample-engine.js', 'src/engine-next.js', 'src/engine-numbers.js', 'src/ordinary.js',
    'src/misleading-engine.js', 'src/forwarded-engine.js', 'src/move-history/152.json'];
  box.put(paths[0], 'export const SAMPLE_ENGINE = 17;\n');
  box.put(paths[1], 'export function unassignedEngine() { return 18; }\n');
  box.put(paths[2], 'export function nextEngineNumber() { return 18; }\n');
  box.put(paths[3], 'export function ordinary() { return 1; }\n');
  box.put(paths[4], 'export function ordinaryEngine() { return 1; }\n');
  box.put(paths[5], "export { SAMPLE_ENGINE } from './sample-engine.js';\n");
  box.put(paths[6], '{"version":1,"engine":152,"name":"sample","declarations":{}}\n');
  const seed = JSON.parse(readFileSync(join(box.root, 'packages/codemap/data/plan/seed.json'), 'utf8'));
  seed.order.splice(1, 0, cellName);
  seed.cells[cellName] = paths;
  if (cellName !== 'state') {
    box.put('src/state-sample-engine.js', 'export const STATE_SAMPLE_ENGINE = 19;\n');
    seed.order.splice(1, 0, 'state');
    seed.cells.state = ['src/state-sample-engine.js'];
  }
  box.put('packages/codemap/data/plan/seed.json', JSON.stringify(seed));
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
  rmSync(join(box.root, 'packages/codemap/data/baselines/lints'), { recursive: true });
  writeCellLintBaseline(box.root, complete, { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'accepted complete baseline');
  return { ...box, plan, paths, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/** Evaluate committed candidate metadata through the immutable controller, never a candidate evaluator. */
async function inspect(box) {
  // The accepted-main inventory is produced by a background job on a runner; the test produces its own (a test never waits on one).
  await warmAcceptedCells(box.root, box.main, { withCheckout: withMainCheckout, withLock: withFileLock });
  writePlan(box.root, box.plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate explicit engine stays');
  return await requireSubmitCells(box.root, box.main, git(box.root, 'rev-parse', 'HEAD').trim(),
    { item_frozen: JSON.stringify({ criterion: 'Retain listed engine identities and the two approved bootstrap support leaves.' }) },
    { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
      readCutItems: () => [], cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
}

test('listed canonical engine leaves and the two bootstrap supports stay without changing source [C7,CD64]', async t => {
  const box = accepted(t), paths = [...box.paths.slice(0, 3), box.paths[6]];
  const original = paths.map(file => readFileSync(join(box.root, file), 'utf8'));
  box.plan = retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'state', paths, pathMap: new Map() });
  assert.deepEqual(box.plan.engineStays.map(entry => entry.row[0]), paths);
  assert.deepEqual(paths.map(file => readFileSync(join(box.root, file), 'utf8')), original);
  assert.deepEqual((await inspect(box)).problems, []);
});

test('a non-state cell retains its own engine leaf and survives the immutable submit controller [C7,CD64]', async t => {
  const box = accepted(t, 'stats'), paths = [box.paths[0], box.paths[6]];
  const original = paths.map(file => readFileSync(join(box.root, file), 'utf8'));
  box.plan = retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'stats', paths, pathMap: new Map() });
  assert.deepEqual(box.plan.engineStays.map(entry => [entry.cell, entry.row[0]]), paths.map(file => ['stats', file]));
  assert.deepEqual(paths.map(file => readFileSync(join(box.root, file), 'utf8')), original);
  assert.deepEqual((await inspect(box)).problems, []);
});

test('retainEnginePaths refuses an ordinary file, an engine-looking name, a non-engine stats file and a missing cell [C7,CD64]', t => {
  const box = accepted(t), stats = accepted(t, 'stats'), refused = error => error.code === 'CELLS_ENGINE_STAY';
  for (const file of box.paths.slice(3, 6)) assert.throws(() => retainEnginePaths({ root: box.root, plan: box.plan, cellName: 'state', paths: [file], pathMap: new Map() }), refused);
  assert.throws(() => retainEnginePaths({ root: stats.root, plan: stats.plan, cellName: 'stats', paths: [stats.paths[3]], pathMap: new Map() }), refused);
  assert.throws(() => retainEnginePaths({ root: stats.root, plan: stats.plan, cellName: 'missing', paths: [stats.paths[0]], pathMap: new Map() }), refused);
});
