/** @pullboard-test-input source-tree */
/** Actual Git moves, committed counts and native SQLite health prove temporary shim debt [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as planFixture, git, acceptedCutItems } from './cells-plan-fixture.js';
import { fixtureBoard } from './board-fixture.js';
import { addItem } from '../packages/store/index.js';
import { dispatchHealth } from '../packages/sentinels/index.js';
import { healthReport, healthLines } from '../packages/health/index.js';
import { defaults, configFromSource } from '../packages/config/index.js';
import { importsIn, commonJsIn, withImportParseCache, foreignNodeOptions } from '../packages/gate/index.js';
import { cellLintReport, cellLintBaseline, writeCellLintBaseline, shimCountBaseline, shimLifecycle } from '../packages/codemap/index.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { computePlan, writePlan } from '../bin/cells-plan.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { cellsMove } from '../bin/cells-move-tool.js';

const COUNTS = 'bin/cell-lint-baselines/shim-counts.json';
const parsers = { importsIn, commonJsIn };

/** Build committed native plan policy with a real falling baseline and a distinct candidate branch. */
function fixture(t) {
  const box = planFixture(t);
  box.root = realpathSync(box.root);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'plan actual shim fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, parsers)), { initialize: true });
  box.put(COUNTS, JSON.stringify(shimCountBaseline(cellLintReport(box.root, parsers))));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'record initial shim counts');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  git(box.root, 'checkout', '-qb', 'candidate');
  return { ...box, main };
}

/** Record the source count, then inspect its immutable candidate with the exact native submit guard. */
async function inspect(box, { updateCounts = true } = {}) {
  if (updateCounts) box.put(COUNTS, JSON.stringify(shimCountBaseline(cellLintReport(box.root, parsers))));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'candidate shim source');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  await requireSubmitCells(box.root, box.main, commit, { item_frozen: JSON.stringify({ criterion: 'Preserve cell moves and temporary shims.' }) },
    { withMainCheckout, parsers, withImportParseCache, readCutItems: () => acceptedCutItems(box.root, box.main),
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
  return commit;
}

/** Apply the actual move transaction; it creates the body, front door, compatibility shim and path-map shard. */
function move(box, t) {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), 'pb-shim-custody-')));
  t.after(() => rmSync(custody, { recursive: true, force: true }));
  cellsMove.apply(cellsMove.plan({ root: box.root, from: 'src/refused.js', to: 'packages/kernel/src/core/refused.js',
    frontDoor: 'packages/kernel/index.js', purpose: 'Expose the actual fixture refusal class.' }), custody);
}

test('a real cells move may land with its new shim count committed [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  const commit = await inspect(box);
  git(box.root, 'checkout', '-q', 'main');
  git(box.root, 'merge', '--no-ff', '-qm', 'land actual cells move', commit);
  assert.deepEqual(JSON.parse(readFileSync(join(box.root, COUNTS))), { version: 1, cells: { kernel: 1 } });
  assert.equal(cellLintReport(box.root, parsers).metrics.shims.count, 1);
  const records = shimLifecycle(box.root, { items: [{ item_id: 23, item_title: 'Remove kernel shims', item_criterion: 'Delete src/refused.js', item_status: 'open' }] });
  assert.equal(records.length, 1);
  assert.equal(records[0].moveLandedAt, git(box.root, 'log', '-1', '--format=%cI').trim(), 'age starts at the real merge landing');
  assert.equal(records[0].removalItem, 23);
});

test('a stray shim refuses even when the builder updates the count snapshot [C7,CD64]', async t => {
  const box = fixture(t);
  box.put('src/stray.js', "export { Refused } from './refused.js';\n");
  await assert.rejects(inspect(box), error => error.code === 'CELLS_SUBMIT' && /shim count rose without a cells move: src\/stray.js/u.test(error.message));
});

test('a cells move must record its actual shim count before landing [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  await assert.rejects(inspect(box, { updateCounts: false }), error => error.code === 'CELLS_SUBMIT' && /shim count baseline differs/u.test(error.message));
});

test('native health names an aged shim, its cell and the removal item at the configured age [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  const commit = await inspect(box);
  git(box.root, 'checkout', '-q', 'main');
  git(box.root, 'merge', '--no-ff', '-qm', 'land health shim fixture', commit);
  const landed = Date.parse(git(box.root, 'log', '-1', '--format=%cI').trim());
  const board = fixtureBoard(t);
  const removal = addItem(board, { by: 'coordinator', lane: 'core', title: 'Remove the kernel shim', criterion: 'Delete src/refused.js through its front door.' });
  const observe = days => healthReport({ db: board.db, root: box.root,
    config: configFromSource(JSON.stringify({ ...defaults(), cells: { cache: false, shimMaxAgeDays: days } })),
    now: new Date(landed + 8 * 86_400_000), dispatchHealth });
  const report = observe(7);
  const finding = report.stuck.find(row => row.cause === 'CELL_SHIM_OVERDUE');
  assert.equal(finding?.subject, 'src/refused.js');
  assert.equal(finding.detail.cell, 'kernel');
  assert.equal(finding.detail.removalItem, removal);
  assert.ok(healthLines(report).some(line => line.includes('src/refused.js') && line.includes(`#${removal}`)));
  assert.equal(observe(9).stuck.some(row => row.cause === 'CELL_SHIM_OVERDUE'), false);
});
