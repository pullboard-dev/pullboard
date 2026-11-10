/** @pullboard-test-input source-tree */
/** Cell-lint and shim ratchets count main and the candidate at check time; no committed baseline must match source [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture as planFixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { publishAcceptedCells } from '../../../../packages/landing/tests/fixtures/plan.js';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellsMove } from '../../../../packages/codemap/src/io/cells/move/tool.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const parsers = { importsIn, commonJsIn };
const LINTS = fileURLToPath(new URL('../../../../packages/codemap/src/io/cell/scripts/lints.js', import.meta.url));

/**
 * Build a real repo whose main records a cell-lint baseline, then lands a cells move that adds a shim
 * without touching any baseline file, so main's committed snapshot no longer matches main's own source.
 */
async function staleMain(t) {
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
  cellsMove.apply(cellsMove.plan({ root: box.root, from: 'src/refused.js', to: 'packages/kernel/src/logic/refused.js',
    frontDoor: 'packages/kernel/index.js', purpose: 'Expose the fixture refusal class.' }), custody);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'main lands a move and its shim without touching a baseline');
  assert.equal(readFileSync(join(box.root, CELL_BASELINE_DESCRIPTOR), 'utf8'), recorded, 'main left its baseline untouched');
  assert.equal(existsSync(join(box.root, 'packages/codemap/data/baselines/lints/shim-counts.json')), false);
  assert.ok(cellLintReport(box.root, parsers).metrics.shims.findings.some(row => row.key === 'src/refused.js'), 'main really gained a shim');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  const artifact = await publishAcceptedCells(t, box.root, main);
  git(box.root, 'checkout', '-qb', 'candidate');
  return { ...box, main, artifact };
}

/** Commit the candidate and run the exact native cells submit guard against main. */
async function submit(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'candidate change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  await requireSubmitCells(box.root, box.main, commit, { item_frozen: JSON.stringify({ criterion: 'Change the stats cell.' }) },
    { withMainCheckout, parsers, withImportParseCache, readCutItems: () => acceptedCutItems(box.root, box.main),
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), acceptedArtifact: box.artifact });
  return commit;
}

test('main gains a shim without touching any baseline file and an unrelated item still submits [C7]', async t => {
  const box = await staleMain(t);
  box.put('src/stats.js', readFileSync(join(box.root, 'src/stats.js'), 'utf8') + '// an unrelated edit in a planned cell\n');
  assert.match(await submit(box), /^[0-9a-f]{40}$/u);
});

test('an item that adds a shim over main is refused naming the shim file [C7]', async t => {
  const box = await staleMain(t);
  box.put('src/stats-flow.js', "export { stats as flow } from './stats.js';\n");
  await assert.rejects(submit(box), error => error.code === 'CELLS_SUBMIT'
    && /shim count rose without a cells move: src\/stats-flow\.js/u.test(error.message)
    && !/src\/refused\.js/u.test(error.message)
    && !/baseline/u.test(error.message));
});

/**
 * Build a strict (post-migration) repo whose main records a cell-lint baseline once, then gains
 * non-shim debt without touching it, so the committed snapshot is stale against main's own source.
 */
function staleLintMain(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pb-ratchet-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Ratchet fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Ratchet fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  /** Write one private fixture file. */
  const put = (file, source) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); };
  const check = () => runFixtureChild(process.execPath, [LINTS, '--check', root], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js' } }));
  put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  put('packages/sample/index.js', 'export const value = 1;\n');
  put('packages/codemap/data/plan/path-map/sample.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  git('add', '-A'); git('commit', '-qm', 'accepted migration');
  assert.equal(cellLintReport(root, parsers).transition.active, false, 'the fixture ratchet is strict');
  writeCellLintBaseline(root, cellLintBaseline(cellLintReport(root, parsers)), { initialize: true });
  git('add', '-A'); git('commit', '-qm', 'record the cell lint baseline once');
  const recorded = readFileSync(join(root, CELL_BASELINE_DESCRIPTOR), 'utf8');
  put('landed-stray.js', 'void 0;\n');
  put('apps/demo/index.js', "import { value } from '../../packages/sample/index.js'; console.log(value);\n");
  git('add', '-A'); git('commit', '-qm', 'main lands stray and boundary debt without touching a baseline');
  assert.equal(readFileSync(join(root, CELL_BASELINE_DESCRIPTOR), 'utf8'), recorded, 'main left its baseline untouched');
  git('checkout', '-qb', 'candidate');
  return { root, git, put, check };
}

test('cell-lints --check passes an unrelated item while main carries non-shim debt over its stale baseline [C7]', t => {
  const box = staleLintMain(t);
  box.put('packages/sample/index.js', 'export const value = 2;\n');
  const checked = box.check();
  assert.equal(checked.status, 0, checked.stderr);
  assert.doesNotMatch(checked.stderr, /landed-stray\.js|exceeds/u);
  rmSync(join(box.root, 'packages/codemap/data/baselines/lints'), { recursive: true, force: true });
  box.git('add', '-A'); box.git('commit', '-qm', 'candidate deletes the stored baseline');
  const without = box.check();
  assert.equal(without.status, 0, `no committed baseline is needed: ${without.stderr}`);
});

test('cell-lints --check refuses only the debt the item adds over main, naming its file [C7]', t => {
  const box = staleLintMain(t);
  box.put('item-stray.js', 'void 0;\n');
  const checked = box.check();
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /strays:item-stray\.js/u);
  assert.doesNotMatch(checked.stderr, /landed-stray\.js|boundaries/u);
});
