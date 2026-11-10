import * as store from '../../../../packages/store/index.js';
import { registerPreGrant } from '../../tests/fixtures/seats.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { landedCutItemRows } from '../../index.js';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
/** A cell's landed import cut is a ratchet: new upward or front-door-skipping imports refuse at submit, old ones do not [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells as preflight } from '../../index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

/** Bind the real controller services, as submit does. */
const requireSubmitCells = async (root, main, commit, item, readCutItems = () => acceptedCutItems(root, main)) => {
  // The accepted-main inventory is produced by a background job on a runner; the test produces its own (a test never waits on one).
  await warmAcceptedCells(root, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: main });
  return preflight(root, main, commit, item,
    { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, readCutItems,
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
};

/** Commit a planned fixture with its real lint baseline, so main is a clean accepted snapshot. */
function plannedFixture(t, prepare = () => {}) {
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim(), item: { item_title: 'Cells move 1/1: fixture moves behind shims', item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) } };
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

/** Create real private-board lifecycle state through the normal operations and immutable synthetic receipts. */
function cutBoard(t, name, status, merged) {
  const board = fixtureBoard(t);
  const [, builder, reviewer] = registerPreGrant(board, [
    ['coordinator', '/cut-coordinator', { family: 'Fixture Coordinator' }],
    ['core', '/cut-builder', { family: 'Fixture Builder' }],
    ['core', '/cut-reviewer', { family: 'Fixture Reviewer' }],
  ]);
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Cells import cuts: ${name} removes imports into later cells` });
  if (status === 'open') return board;
  if (status === 'withdrawn') { store.withdraw(board, id, { agentId: 'coordinator', reason: 'Private cut status control.' }); return board; }
  const freeze = () => ({ text: JSON.stringify({ rows: [] }), digest: 'digest:cut' });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze });
  const commit = merged ?? 'a'.repeat(40);
  submitFixture(board, id, { agentId: builder, commit, tree: 'b'.repeat(40) });
  if (status === 'submitted') return board;
  store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', head: commit, digest: 'digest:cut', policy: 'any', note: 'Private lifecycle authority fixture; no test-execution claim.' });
  if (merged) store.merged(board, id, { agentId: 'coordinator', commit: merged });
  return board;
}

test('an empty cut graph without a landed board item grants neither refusal [C7,D3]', async t => {
  const box = plannedFixture(t), board = fixtureBoard(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  box.put('src/cli.js', "import { board } from './board.js'; console.log(board);\n");
  box.put('cut-items.json', JSON.stringify({ kernel: { status: 'verified', merged: box.main } }));
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db));
  assert.deepEqual(result.problems, [], 'candidate status metadata and static cleanliness are not cut authority');
});

test('actual board status and pinned ancestry activate the upward ratchet only after landing [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const candidate = commitCandidate(box);
  for (const [status, merged] of [['open', box.main], ['submitted', box.main], ['verified', null], ['withdrawn', box.main], ['verified', candidate]]) {
    const board = cutBoard(t, 'kernel', status, merged);
    assert.deepEqual((await requireSubmitCells(box.root, box.main, candidate, box.item, () => landedCutItemRows(board.db))).problems, [],
      `${status}/${merged} is not a cut landed on pinned main`);
  }
  const board = cutBoard(t, 'kernel', 'verified', box.main), read = () => landedCutItemRows(board.db);
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate, box.item, read), /kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
  board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES ('item_redirect:' || (SELECT item_id FROM item), '1')").run();
  assert.deepEqual((await requireSubmitCells(box.root, box.main, candidate, box.item, read)).problems, [], 'redirected historical cut rows cannot activate the ratchet');
});

test('a landed cut still refuses new edges when its accepted graph has older debt [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  box.main = commitCandidate(box);
  const board = cutBoard(t, 'kernel', 'verified', box.main);
  box.put('src/refused.js', "import './stats-flow.js'; import './stats.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db)),
    /kernel still imports later stats: src\/refused.js -> src\/stats.js/u);
});

test('landed front-door enforcement does not mistake older upward debt for an unlanded cut [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/stats-flow.js', "import './cli.js'; export const flow = true;\n");
  box.main = commitCandidate(box);
  const board = cutBoard(t, 'stats', 'verified', box.main);
  box.put('src/stats.js', "import { board } from './board.js'; import './refused.js'; export const stats = () => board;\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db)),
    /stats imports lower kernel past its front door .*src\/stats.js -> src\/refused.js/u);
});

test('existing cut debt does not refuse an unchanged candidate [C7,D3]', async t => {
  const box = plannedFixture(t);
  const result = await requireSubmitCells(box.root, box.main, box.main, box.item, () => []);
  assert.deepEqual(result.problems, []);
  // A touched file retains the same older edge: it is no new refusal, and submit no longer lists the accepted backlog
  // (it belongs to the main audit: 7a6b37bef3, cutDeltaProblems).
  box.put('src/board.js', "import { Refused } from './refused.js'; import { claims } from './claims.js'; export const board = () => [Refused, claims, 2];\n");
  const changed = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => []);
  assert.deepEqual(changed.problems, []);
  assert.deepEqual(changed.existingCuts, [], 'the accepted cut backlog is left to the main audit, not listed on every submit');
});

test('current main cannot conceal a candidate new edge that was absent at its actual merge base [C7,D3]', async t => {
  const box = plannedFixture(t), base = box.main;
  const source = "import './stats-flow.js'; export class Refused extends Error {}\n";
  box.put('src/refused.js', source);
  const candidate = commitCandidate(box);
  git(box.root, 'checkout', '--detach', base);
  box.put('src/refused.js', source);
  box.put('README.md', 'Accepted main advanced independently.\n');
  box.main = commitCandidate(box);
  assert.equal(git(box.root, 'merge-base', box.main, candidate).trim(), base);
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate, box.item),
    /kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
});

test('an edge introduced only by newer accepted main is not attributed to the candidate [C7,D3]', async t => {
  const box = plannedFixture(t), base = box.main;
  box.put('src/stats.js', "import { board } from './board.js'; export const stats = () => [board, 2];\n");
  const candidate = commitCandidate(box);
  git(box.root, 'checkout', '--detach', base);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  box.main = commitCandidate(box);
  const result = await requireSubmitCells(box.root, box.main, candidate, box.item);
  assert.equal(result.cutBase, base);
  assert.deepEqual(result.problems, []);
});

test('a newly declared computed import cannot bypass a landed cell front door within old unknown debt [C7,D3]', async t => {
  const source = "export const load = name => import(name);\n";
  const box = plannedFixture(t, box => box.put('src/cli.js', source));
  const board = cutBoard(t, 'app:cli', 'verified', box.main);
  box.put('src/cli.js', '/** @pullboard-module-loads src/board.js */\n' + source);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db)),
    /app:cli imports lower store past its front door .*src\/cli.js -> src\/board.js/u);
});

test('an actual static lower import cannot borrow unchanged accepted wildcard authority [C7,D3]', async t => {
  const source = '/** @pullboard-module-loads src/stats*.js */\nexport const load = name => import(name);\n';
  const box = plannedFixture(t, box => box.put('src/cli.js', source));
  const board = cutBoard(t, 'app:cli', 'verified', box.main);
  box.put('src/cli.js', source + "import './stats-flow.js';\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db)),
    /app:cli imports lower stats past its front door .*src\/cli.js -> src\/stats-flow.js/u);
});

test('unchanged accepted wildcard authority still covers a future matching lower file [C7,D3]', async t => {
  const source = '/** @pullboard-module-loads src/stats*.js */\nexport const load = name => import(name);\n';
  const box = plannedFixture(t, box => box.put('src/cli.js', source));
  const board = cutBoard(t, 'app:cli', 'verified', box.main), plan = readPlan(box.root);
  box.put('src/stats-extra.js', 'export const extra = true;\n');
  const cell = plan.cells.find(row => row.name === 'stats');
  cell.paths.push(['src/stats-extra.js', `${cell.root}/src/core/stats-extra.js`, 'rule']);
  writePlan(box.root, plan);
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item, () => landedCutItemRows(board.db))).problems, []);
});
