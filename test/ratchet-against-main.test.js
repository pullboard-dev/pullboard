/** @pullboard-test-input source-tree */
/** Cell-lint and shim ratchets count main and the candidate at check time; no committed baseline must match source [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as planFixture, git, acceptedCutItems } from './cells-plan-fixture.js';
import { importsIn, commonJsIn, withImportParseCache, foreignNodeOptions } from '../packages/gate/index.js';
import { cellLintReport, cellLintBaseline, writeCellLintBaseline, CELL_BASELINE_DESCRIPTOR } from '../packages/codemap/index.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { computePlan, writePlan } from '../bin/cells-plan.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { cellsMove } from '../bin/cells-move-tool.js';

const parsers = { importsIn, commonJsIn };

/**
 * Build a real repo whose main records a cell-lint baseline, then lands a cells move that adds a shim
 * without touching any baseline file, so main's committed snapshot no longer matches main's own source.
 */
function staleMain(t) {
  const box = planFixture(t);
  box.root = realpathSync(box.root);
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'src/cli.js' }));
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'plan the ratchet fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, parsers)), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'record the cell lint baseline once');
  const recorded = readFileSync(join(box.root, CELL_BASELINE_DESCRIPTOR), 'utf8');
  const custody = realpathSync(mkdtempSync(join(tmpdir(), 'pb-ratchet-custody-')));
  t.after(() => rmSync(custody, { recursive: true, force: true }));
  cellsMove.apply(cellsMove.plan({ root: box.root, from: 'src/refused.js', to: 'packages/kernel/src/core/refused.js',
    frontDoor: 'packages/kernel/index.js', purpose: 'Expose the fixture refusal class.' }), custody);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'main lands a move and its shim without touching a baseline');
  assert.equal(readFileSync(join(box.root, CELL_BASELINE_DESCRIPTOR), 'utf8'), recorded, 'main left its baseline untouched');
  assert.equal(existsSync(join(box.root, 'bin/cell-lint-baselines/shim-counts.json')), false);
  assert.ok(cellLintReport(box.root, parsers).metrics.shims.findings.some(row => row.key === 'src/refused.js'), 'main really gained a shim');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  git(box.root, 'checkout', '-qb', 'candidate');
  return { ...box, main };
}

/** Commit the candidate and run the exact native cells submit guard against main. */
async function submit(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'candidate change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  await requireSubmitCells(box.root, box.main, commit, { item_frozen: JSON.stringify({ criterion: 'Change the stats cell.' }) },
    { withMainCheckout, parsers, withImportParseCache, readCutItems: () => acceptedCutItems(box.root, box.main),
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
  return commit;
}

test('main gains a shim without touching any baseline file and an unrelated item still submits [C7]', async t => {
  const box = staleMain(t);
  box.put('src/stats.js', readFileSync(join(box.root, 'src/stats.js'), 'utf8') + '// an unrelated edit in a planned cell\n');
  assert.match(await submit(box), /^[0-9a-f]{40}$/u);
});

test('an item that adds a shim over main is refused naming the shim file [C7]', async t => {
  const box = staleMain(t);
  box.put('src/stats-flow.js', "export { stats as flow } from './stats.js';\n");
  await assert.rejects(submit(box), error => error.code === 'CELLS_SUBMIT'
    && /shim count rose without a cells move: src\/stats-flow\.js/u.test(error.message)
    && !/src\/refused\.js/u.test(error.message)
    && !/baseline/u.test(error.message));
});
