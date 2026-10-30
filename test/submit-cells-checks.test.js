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
