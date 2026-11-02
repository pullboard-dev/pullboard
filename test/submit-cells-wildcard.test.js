import { acceptedCutItems } from './cells-plan-fixture.js';
/** Submit compares accepted wildcard authority without exempting genuine static or newly widened imports [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { computePlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { checkCuts } from '../bin/cells-plan-cuts.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { withImportParseCache } from '../src/module-import-cache.js';
import { foreignNodeOptions } from '../src/test-isolation.js';

const parsers = { importsIn, commonJsIn };
const services = { withMainCheckout, parsers, withImportParseCache, readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) };

/** Commit a real accepted loader and its complete existing debt; candidate source is never executed. */
function acceptedLoader(t, pattern = '**') {
  const box = fixture(t);
  const source = `/** @pullboard-module-loads ${pattern} */\nexport class Refused extends Error {}\nexport function load(name) { return import(name); }\n`;
  box.put('src/refused.js', source);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted loader placement');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, parsers)), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted actual debt');
  return { ...box, source, main: git(box.root, 'rev-parse', 'HEAD').trim(), item: { item_frozen: JSON.stringify({ criterion: 'Preserve real boundaries.' }) } };
}

/** Place one actual later-cell module through the canonical writer, retaining all accepted rows. */
function addLaterFile(box) {
  box.put('src/new-cli.js', 'throw new Error("candidate code must never execute during analysis");\n');
  const plan = readPlan(box.root);
  const cell = plan.cells.find(row => row.name === 'app:cli');
  cell.paths.push(['src/new-cli.js', `${cell.root}/src/shell/new-cli.js`, 'rule']);
  writePlan(box.root, plan);
}

/** Commit exactly the candidate bytes analyzed by the real immutable-snapshot controller. */
function candidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'candidate source and placement');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('submit accepts a new later file covered only by unchanged accepted wildcard debt [C7,D3,CD64]', async t => {
  const box = acceptedLoader(t);
  addLaterFile(box);
  box.put('src/refused.js', box.source + '// An unrelated body comment does not change loader authority.\n');
  const commit = candidate(box);
  assert.ok(checkCuts(box.root, readPlan(box.root), 'kernel', { allLaterCells: true, temporaryExceptions: false })
    .some(problem => problem.includes('src/refused.js -> src/new-cli.js')), 'ordinary standalone cuts keep the complete wildcard reach');
  const result = await requireSubmitCells(box.root, box.main, commit, box.item, services);
  assert.deepEqual(result.problems, []);
});

test('submit still refuses an actual static import to the same wildcard-covered later file [C7,D3,CD64]', async t => {
  const box = acceptedLoader(t);
  addLaterFile(box);
  box.put('src/refused.js', box.source + "import './new-cli.js';\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate(box), box.item, services),
    /kernel --cuts: kernel still imports later app:cli: src\/refused.js -> src\/new-cli.js/u);
});

test('submit cannot borrow old computed debt for a new static import to an existing file [C7,D3,CD64]', async t => {
  const box = acceptedLoader(t);
  box.put('src/refused.js', box.source + "import './stats-flow.js';\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate(box), box.item, services),
    /kernel --cuts: kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
});

test('submit refuses a newly widened wildcard rather than borrowing accepted narrower authority [C7,D3,CD64]', async t => {
  const box = acceptedLoader(t, 'src/stats*.js');
  addLaterFile(box);
  box.put('src/refused.js', box.source.replace('src/stats*.js', '**'));
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate(box), box.item, services),
    /kernel --cuts: kernel still imports later app:cli: src\/refused.js -> src\/new-cli.js/u);
});

test('submit does not use accepted wildcard debt to forgive malformed candidate declarations [C7,D3,CD64]', async t => {
  const box = acceptedLoader(t);
  addLaterFile(box);
  box.put('src/refused.js', box.source.replace('module-loads **', 'module-loads [invalid]'));
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate(box), box.item, services), /cannot prove cut through src\/refused.js/u);
});
