import { withImportParseCache } from '../src/module-import-cache.js';
/** A cell's landed import cut is a ratchet: new upward or front-door-skipping imports refuse at submit, old ones do not [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { requireSubmitCells as preflight } from '../bin/cells-submit-checks.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { withMainCheckout } from '../src/main-red.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { foreignNodeOptions } from '../src/test-isolation.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

/** Bind the real controller services, as submit does. */
const requireSubmitCells = (...args) => preflight(...args, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });

/** Commit a planned fixture with its real lint baseline, so main is a clean accepted snapshot. */
function plannedFixture(t) {
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim(), item: { item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) } };
}

/** Commit the candidate the immutable preflight will inspect. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('a candidate adding an upward edge from a landed cell refuses naming the edge and the fix [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item),
    /kernel still imports later stats: src\/refused.js -> src\/stats-flow.js; import a lower cell or take a port/u);
});

test('a candidate adding no edge passes and an existing edge does not refuse [C7,D3]', async t => {
  const box = plannedFixture(t);
  assert.deepEqual((await requireSubmitCells(box.root, box.main, box.main, box.item)).problems, [], 'existing lower imports are backlog');
  box.put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync, 1];\n");
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'editing a file that keeps its old edges adds none');
});

test('a landed cell adding a lower import past the front door refuses naming it [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/cli.js', "import { stats } from './stats.js';\nimport { flow } from './stats-flow.js';\nimport { board } from './board.js';\nconsole.log(stats, flow, board);\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item),
    /app:cli imports lower store past its front door .*: src\/cli.js -> src\/board.js; import the lower cell's front door or take a port/u);
});
