/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCuts } from '../bin/cells-plan-cuts.js';
import { computePlan } from '../bin/cells-plan.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

test('submit cut mode catches a new target even when a cell has no historical cuts [C7,D3,CD64]', t => {
  const { root, put } = fixture(t), plan = computePlan(root);
  const early = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/refused.js'));
  const later = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/stats-flow.js'));
  assert.ok(later.order > early.order);
  assert.throws(() => checkCuts(root, plan, early.name), /no import-cut group/u,
    'the existing historical cut command keeps its original mode');
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true }), []);
  put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const diagnostic = `${early.name} still imports later ${later.name}: src/refused.js -> src/stats-flow.js`;
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true }).includes(diagnostic),
    'the actual new edge is named in the unchanged diagnostic format');
  put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js',
    target: 'src/stats-flow.js', contractItem: 123, expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true }), [],
    'existing temporary-edge behavior remains the default');
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }).includes(diagnostic),
    'submit sees the real edge even when a declaration would otherwise exempt it');
  put('src/refused.js', "export async function load(name) { return import(name); }\n");
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false })
    .some(problem => problem.includes('cannot prove')), 'expanded cut mode never forgives unknown loaders');
});


test('submit cuts follow a declared root tool body so a stay cannot hide a later dependency [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('bin/bridge.js', "import '../src/stats-flow.js'; export const bridge = true;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'private root tool bridge');
  const plan = computePlan(root);
  const early = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/refused.js'));
  const later = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/stats-flow.js'));
  assert.ok(plan.stays.some(row => row.path === 'bin/bridge.js'), 'the helper is genuinely placed as a root tool');
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }), []);
  put('src/refused.js', "import '../bin/bridge.js'; export class Refused extends Error {}\n");
  const diagnostic = `${early.name} still imports later ${later.name}: bin/bridge.js -> src/stats-flow.js`;
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }).includes(diagnostic),
    'the new upstream import cannot conceal the actual later edge behind an owned root-tool body');
  put('bin/bridge.js', 'export async function bridge(name) { return import(name); }\n');
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false })
    .some(problem => problem.includes('cannot prove cut through bin/bridge.js')), 'an unknown root-tool loader also refuses');
});

import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { writePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';

/** Commit the actual small plan and complete canonical baseline, with no production-source substitution. */
function plannedFixture(t, prepare = () => {}) {
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim(), item: { item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) } };
}

/** Commit the exact candidate the real immutable-snapshot preflight will inspect. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate composition');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('submit accepts unchanged scheduled debt but refuses an unplaced committed source before executing it [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  const clean = await requireSubmitCells(box.root, box.main, box.main, box.item);
  assert.deepEqual(clean.problems, []);
  box.put('src/new-unsafe.js', 'throw new Error("candidate module must never execute");\n');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /unplaced src\/new-unsafe.js/u);
});

test('submit names a new later edge even when candidate metadata declares it temporary [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const commit = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, commit, box.item), /kernel --cuts: kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
  box.put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
    expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
  const declared = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, box.item), /frozen criterion does not name exact edge/u);
  const authorized = { item_frozen: JSON.stringify({ criterion: 'Temporary src/refused.js -> src/stats-flow.js under contract 123.' }) };
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, authorized), /kernel --cuts: kernel still imports later stats/u,
    'exact metadata authority never exempts the actual new later-cell edge');
});

test('submit keeps accepted placement authority when a candidate drops a row into stays or changes cell order [C7,D3,CD64]', async t => {
  const box = plannedFixture(t), plan = readPlan(box.root);
  const early = plan.cells.find(cell => cell.name === 'kernel');
  const row = early.paths.shift();
  plan.stays.push({ path: row[0], reason: 'forged candidate exemption' });
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /accepted row src\/refused.js disappeared/u);
  early.paths.push(row);
  early.order = 999;
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /accepted cell kernel identity\/order\/front door changed/u);
});

test('submit compares lints with accepted allowances even if a candidate rewrites its own baseline [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', 'export class Refused extends Error {}\n' + '\n'.repeat(1501));
  const report = cellLintReport(box.root, { importsIn, commonJsIn });
  writeCellLintBaseline(box.root, cellLintBaseline(report));
  assert.ok(report.metrics.fileSize.findings.some(row => row.key === 'src/refused.js' && row.count > 1000), 'the actual source crosses the unchanged hard 1500-line cap');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /cell lint fileSize:src\/refused.js/u,
    'the candidate baseline cannot authorize its own hard-cap rise');
});


test('submit accepts a real clean move and keeps an existing temporary edge as unchanged debt [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
    box.put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
      expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'actual preexisting temporary edge');
  });
  box.put('bin/tool.js', "import '../src/cli.js'; // unchanged runtime dependency\n");
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'temporary exceptions are disabled in both snapshots and the old exact edge is still equal debt');
  const clean = plannedFixture(t);
  clean.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
  clean.put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
  clean.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  clean.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  clean.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
  assert.deepEqual((await requireSubmitCells(clean.root, clean.main, commitCandidate(clean), clean.item)).problems, [],
    'the actual reachable named front door and body satisfy the canonical move check');
});

test('submit ignores candidate checker code and refuses a forged overlapping ownership root [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('bin/cells-plan-cuts.js', 'export const fixtureChecker = true;\n');
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'private checker source');
  });
  box.put('bin/cells-plan-cuts.js', 'throw new Error("candidate checker execution is forbidden");\n');
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --cuts: kernel still imports later stats/u);
  const plan = readPlan(box.root);
  plan.cells.unshift({ order: 44, name: 'forged', kind: 'package', root: 'packages', frontDoor: 'packages/index.js', paths: [], reexports: [], imports: [], cuts: [] });
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /overlapping cell root/u,
    'a new cell cannot shadow all accepted package owners');
});
