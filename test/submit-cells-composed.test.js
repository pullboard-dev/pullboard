/** Immutable submit census composes later accepted placement authority [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, git } from './cells-plan-fixture.js';
import { computePlan, readPlan, writePlan, shardFile } from '../bin/cells-plan.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { cellLintReport, cellLintBaseline, writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn, commonJsIn } from '../src/module-imports.js';
import { withImportParseCache } from '../src/module-import-cache.js';
import { withMainCheckout } from '../src/main-red.js';
import { foreignNodeOptions } from '../src/test-isolation.js';

const services = { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
  cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) };
const item = { item_frozen: JSON.stringify({ criterion: 'Preserve accepted placement authority and all cell boundaries.' }) };

/** Commit only actual fixture files through ordinary Git. */
function commit(box, message) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', message);
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

/** Main adds a real placed source after the candidate's base, in a different shard from deletion controls. */
function diverged(t, change) {
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  const base = commit(box, 'planned fixture with actual baseline');
  box.put('src/later.js', 'export const later = true;\n');
  const plan = readPlan(box.root), cell = plan.cells.find(row => row.name === 'stats');
  cell.paths.push(['src/later.js', `${cell.root}/src/core/later.js`, 'rule']);
  writePlan(box.root, plan);
  const main = commit(box, 'accepted main adds source and placement');
  git(box.root, 'checkout', '--detach', base);
  change(box);
  const candidate = commit(box, 'candidate based on earlier main');
  return { ...box, main, candidate };
}

/** Record caller authority and mutable Git state before immutable inspection. */
function state(box) {
  return ['HEAD', 'index', 'refs'].map(name => name === 'HEAD' ? git(box.root, 'rev-parse', 'HEAD')
    : name === 'index' ? git(box.root, 'write-tree') : git(box.root, 'for-each-ref', '--format=%(refname) %(objectname)'));
}

test('an older candidate preserves a later accepted source and row in its immutable census [C7,D3,CD64]', async t => {
  const box = diverged(t, box => box.put('bin/tool.js', "import '../src/cli.js'; // independent candidate\n"));
  const before = state(box);
  const result = await requireSubmitCells(box.root, box.main, box.candidate, item, services);
  assert.deepEqual(result.problems, []);
  assert.equal(result.acceptedMain, box.main);
  assert.equal(result.source, box.candidate);
  assert.notEqual(result.commit, box.candidate, 'the older raw source is not mistaken for its composition');
  assert.equal(git(box.root, 'rev-parse', `${result.commit}:src/later.js`),
    git(box.root, 'rev-parse', `${box.main}:src/later.js`), 'the exact accepted source blob survives composition');
  assert.equal(JSON.parse(git(box.root, 'show', `${result.commit}:${shardFile(readPlan(box.root).cells.find(cell => cell.name === 'stats'))}`)).paths
    .filter(row => row[0] === 'src/later.js').length, 1);
  assert.deepEqual(state(box), before, 'the census never changes caller HEAD, index or refs');
});

test('composing later main never forgives a candidate deletion of accepted ownership [C7,D3,CD64]', async t => {
  const box = diverged(t, box => {
    const plan = readPlan(box.root), kernel = plan.cells.find(cell => cell.name === 'kernel');
    const row = kernel.paths.shift();
    plan.stays.push({ path: row[0], reason: 'candidate attempts to remove accepted authority' });
    writePlan(box.root, plan);
  });
  const before = state(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, box.candidate, item, services),
    /accepted row src\/refused.js disappeared/u);
  assert.deepEqual(state(box), before);
});

test('a conflicting candidate cannot substitute a guessed cells composition [C7,D3,CD64]', async t => {
  const box = diverged(t, box => box.put('src/later.js', 'export const later = false;\n'));
  const before = state(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, box.candidate, item, services),
    /cannot compose cleanly with pinned accepted main/u);
  assert.deepEqual(state(box), before);
});
