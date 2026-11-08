/** @pullboard-test-input source-tree */
/** The Cells reorg-only checks refuse only Cells reorg work; every other item proceeds with printed warnings [C7,D3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireSubmitCells as preflight } from '../bin/cells-submit-checks.js';
import { computePlan } from '../bin/cells-plan.js';
import { placePath } from '../bin/cells-plan.js';
import { retirePath } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { loadConfig } from '../packages/config/index.js';
import { importsIn } from '../packages/gate/index.js';
import { commonJsIn } from '../packages/gate/index.js';
import { withImportParseCache } from '../packages/gate/index.js';
import { foreignNodeOptions } from '../packages/gate/index.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { acceptedCutItems } from './cells-plan-fixture.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

const ORDINARY = 'Health counts work-free claim releases';
const MOVE = 'Cells move 1/1: kernel moves into packages/kernel behind shims';

/** Bind the real controller services the submit command passes. */
const requireSubmitCells = (root, main, commit, title) => preflight(root, main, commit,
  { item_title: title, item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) },
  { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, readCutItems: (base, at) => acceptedCutItems(at, base),
    cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });

/** The refusal a candidate draws, or null when it proceeds. */
async function refusal(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

/** Commit the real plan and lint baseline of the small fixture; with moved, main has already moved the kernel cell. */
function plannedFixture(t, { moved = false, prepare = () => {} } = {}) {
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  if (moved) {
    box.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
    box.put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
    box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
    box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
    box.put('bin/cells-plan/path-map/kernel.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
    // The real repository's committed marker keeps pre-cell lint growth advisory after the first package move.
    box.put('bin/cells-plan/transition.json', JSON.stringify({ version: 1, deleteItem: 1770 }));
  }
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/** Commit the exact candidate the submit cells stage inspects. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

/** A new test whose fixture filesystem binding the prover cannot prove, naming the moved kernel path. */
const UNPROVEN_READER = "const fs = await import('node:fs');\nfs.writeFileSync('fixture/src/refused.js', 'export {};\\n');\n";

test('an ordinary item whose new test builds an unproven fixture path proceeds with a warning; a Cells move item is refused [C7,D3]', async t => {
  const box = plannedFixture(t, { moved: true });
  box.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error { kind = "ordinary"; }\n');
  box.put('test/fixture-reader.test.js', UNPROVEN_READER);
  const candidate = commitCandidate(box);
  const ordinary = await requireSubmitCells(box.root, box.main, candidate, ORDINARY);
  assert.deepEqual(ordinary.problems, []);
  assert.equal(ordinary.reorg, null, 'editing a moved file\'s body is not Cells reorg work');
  const [warning] = ordinary.warnings.filter(line => line.includes('--moved'));
  assert.match(warning, /^cells warning: test\/fixture-reader\.test\.js:1: kernel --moved: .*unsupported fixture source/u, 'file and line');
  assert.match(warning, /; fix: build the path from a proven fixture input port/u, 'the fix');
  const moved = await refusal(requireSubmitCells(box.root, box.main, candidate, MOVE));
  assert.equal(moved?.code, 'CELLS_SUBMIT');
  assert.match(moved.message, /kernel --moved: test\/fixture-reader\.test\.js:1: unsupported fixture source/u);
});

test('an ordinary title is still refused when the item changes a shim, the path map or plan rows [C7,D3]', async t => {
  const box = plannedFixture(t, { moved: true });
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\nexport const shimEdit = 1;\n");
  box.put('test/fixture-reader.test.js', UNPROVEN_READER);
  const shim = await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), ORDINARY));
  assert.match(shim?.message ?? '', /kernel --moved: test\/fixture-reader\.test\.js:1: unsupported fixture source/u, 'a shim change is reorg work');
  git(box.root, 'checkout', '-q', box.main, '--', 'src/refused.js');
  const plan = readPlan(box.root), kernel = plan.cells.find(cell => cell.name === 'kernel');
  kernel.paths = kernel.paths.map(row => row[0] === 'src/refused.js' ? [row[0], 'packages/kernel/src/shell/refused.js', row[2]] : row);
  writePlan(box.root, plan);
  const replanned = await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), ORDINARY));
  assert.ok(replanned, 'retargeting an existing plan row is reorg work and draws the refusals');
});

test('unplaced source warns on an ordinary item, refuses a Cells cut item, and placing its own file stays ordinary [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/unplanned.js', 'export const value = 1;\n');
  const candidate = commitCandidate(box);
  const ordinary = await requireSubmitCells(box.root, box.main, candidate, ORDINARY);
  assert.deepEqual(ordinary.problems, []);
  assert.ok(ordinary.warnings.includes('cells warning: src/unplanned.js:1: no cells-plan placement; fix: node bin/cells-plan.js --place src/unplanned.js --cell <cell> (or --stay), then commit the plan'));
  const cut = await refusal(requireSubmitCells(box.root, box.main, candidate, 'Cells cut: remove the 2 kernel shims'));
  assert.equal(cut?.code, 'CELLS_PLAN_UNPLACED');
  assert.match(cut.message, /src\/unplanned\.js/u);
  placePath(box.root, 'src/unplanned.js', { cell: 'kernel' });
  const placed = await requireSubmitCells(box.root, box.main, commitCandidate(box), ORDINARY);
  assert.equal(placed.reorg, null, 'appending a row for the item\'s own new file is ordinary placement');
  assert.deepEqual(placed.warnings, []);
});

test('a new later-cell import and a deleted path named in a test string warn on ordinary items and refuse reorg items [C7,D3]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "export class Refused extends Error {}\nimport './stats-flow.js';\n");
  const candidate = commitCandidate(box);
  const ordinary = await requireSubmitCells(box.root, box.main, candidate, ORDINARY);
  assert.deepEqual(ordinary.problems, []);
  assert.ok(ordinary.warnings.includes('cells warning: src/refused.js:2: kernel --cuts: kernel still imports later stats: src/refused.js -> src/stats-flow.js; fix: import a lower cell or take a port'),
    ordinary.warnings.join('\n'));
  const moved = await refusal(requireSubmitCells(box.root, box.main, candidate, MOVE));
  assert.match(moved?.message ?? '', /kernel --cuts: kernel still imports later stats: src\/refused.js -> src\/stats-flow.js; import a lower cell or take a port/u);
  const deleting = plannedFixture(t, { prepare: fixture => {
    fixture.put('src/doomed.js', "import { stats } from './stats.js';\nexport const doomed = stats;\n");
    fixture.put('test/child.test.js', "const script = `import('./src/doomed.js').then(m => m.doomed);`;\nexport { script };\n");
  } });
  git(deleting.root, 'rm', '-q', '--', 'src/doomed.js');
  retirePath(deleting.root, 'src/doomed.js');
  const removed = commitCandidate(deleting);
  const warned = await requireSubmitCells(deleting.root, deleting.main, removed, ORDINARY);
  assert.equal(warned.reorg, null, 'retiring the item\'s own deleted row is ordinary');
  assert.ok(warned.warnings.includes('cells warning: test/child.test.js:1: names deleted src/doomed.js inside a string; fix: point it at the moved file or front door'),
    warned.warnings.join('\n'));
  const refused = await refusal(requireSubmitCells(deleting.root, deleting.main, removed, MOVE));
  assert.match(refused?.message ?? '', /test\/child\.test\.js:1 names deleted src\/doomed\.js inside a string/u);
});

test('a singular Cells import cut title and an edited plan-data row are reorg; a data row for the item\'s own new test is not [C7,D3]', async t => {
  const read = (file, line) => ({ file, line, expression: 'fixture.path', kind: 'spec', why: 'reads a generated fixture' });
  const box = plannedFixture(t, { prepare: fixture => {
    fixture.put('bin/cells-plan/data-reads/kernel.json', JSON.stringify({ version: 1, reads: [read('test/old.test.js', 3)] }, null, 2));
  } });
  box.put('src/refused.js', "export class Refused extends Error {}\nimport './stats-flow.js';\n");
  const later = commitCandidate(box);
  assert.deepEqual((await requireSubmitCells(box.root, box.main, later, ORDINARY)).problems, [], 'the import alone warns');
  const cut = await refusal(requireSubmitCells(box.root, box.main, later, 'Cells import cut: kernel removes imports into later cells'));
  assert.match(cut?.message ?? '', /kernel --cuts: kernel still imports later stats/u, 'the singular cut title is reorg work');
  box.put('test/own.test.js', 'export const own = true;\n');
  box.put('bin/cells-plan/data-reads/kernel.json', JSON.stringify({ version: 1, reads: [read('test/old.test.js', 3), read('test/own.test.js', 1)] }, null, 2));
  const own = await requireSubmitCells(box.root, box.main, commitCandidate(box), ORDINARY);
  assert.equal(own.reorg, null, 'a data row naming only the item\'s own new file is ordinary');
  assert.ok(own.warnings.some(line => line.includes('kernel --cuts')));
  box.put('bin/cells-plan/data-reads/kernel.json', JSON.stringify({ version: 1, reads: [read('test/old.test.js', 9), read('test/own.test.js', 1)] }, null, 2));
  const edited = await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), ORDINARY));
  assert.match(edited?.message ?? '', /kernel --cuts: kernel still imports later stats/u, 'editing an existing data-reads row is reorg work');
});

test('native submit of an ordinary item with unplaced source prints the warning and runs its check [C7,V4]', t => {
  const helpers = createE2eHelpers();
  // A detached child the submit starts may still be writing its sandbox; retry the removal until it settles.
  t.after(() => helpers.waitFor(() => { try { helpers.cleanup(); return true; } catch { return false; } }, 'sandbox removal', 60_000)); // budget: lingering detached child ceiling, not a performance assertion.
  const box = helpers.project('node check.cjs');
  box.env.TMPDIR = join(box.dir, 'tmp');
  mkdirSync(box.env.TMPDIR);
  const marker = join(box.dir, 'check-ran');
  writeFileSync(join(box.repo, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  writeFileSync(join(box.repo, 'bin/cells-plan.json'), JSON.stringify({ version: 1, cells: [], stays: [] }) + '\n');
  const config = loadConfig(box.repo);
  config.lanes.web.owns.push('src/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the real placement fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', ORDINARY, '--specs', 'G1', '--criterion', 'An ordinary source lands.',
    '--check', 'node check.cjs', '--wait', '--no-next', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--no-next', '--json').code, 0);
  mkdirSync(join(box.web, 'src'), { recursive: true });
  writeFileSync(join(box.web, 'src/ordinary-added.js'), 'export const value = 1;\n');
  box.git(box.web, 'add', 'src/ordinary-added.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add an ordinary source [G1]');
  rmSync(marker);
  const submitted = box.run(box.web, 'submit', String(id), '--no-next');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.match(submitted.out + submitted.err, /cells warning: src\/ordinary-added\.js:1: no cells-plan placement; fix: node bin\/cells-plan\.js --place src\/ordinary-added\.js/u);
  assert.equal(existsSync(marker), true, 'the ordinary item proceeds to its check');
});
