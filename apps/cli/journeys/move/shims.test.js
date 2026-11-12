/** @pullboard-test-input packages/codemap/data/plan/path-map/kernel.json packages/kernel/index.js packages/kernel/src/logic/refused.js */
/** Actual Git moves, committed counts and native SQLite health prove temporary shim debt [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fixture as planFixture,
  git,
  acceptedCutItems,
} from '../../../../packages/landing/tests/fixtures/plan.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { addItem } from '../../../../packages/store/index.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import {
  healthReport,
  healthLines,
} from '../../../../packages/health/index.js';
import {
  defaults,
  configFromSource,
} from '../../../../packages/config/index.js';
import {
  importsIn,
  commonJsIn,
  withImportParseCache,
  foreignNodeOptions,
  warmAcceptedCells,
} from '../../../../packages/gate/index.js';
import {
  cellLintReport,
  cellLintBaseline,
  writeCellLintBaseline,
  shimLifecycle,
} from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import {
  computePlan,
  writePlan,
} from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellsMove } from '../../../../packages/codemap/src/io/cells/move/tool.js';
import {
  runFixtureGit,
  privateFixtureFiles,
} from '../../tests/fixtures/child.js';

const parsers = { importsIn, commonJsIn };

/** Keep machine-wide cache writes in a disposable directory and restore the invoking process's setting. */
function isolateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const files = privateFixtureFiles('cells-shims-machine-');
  const directory = files.root;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

/** Build committed native plan policy with a real falling baseline and a distinct candidate branch. */
function fixture(t) {
  isolateMachine(t);
  const box = planFixture(t);
  box.root = realpathSync(box.root);
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'src/cli.js' }));
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'plan actual shim fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, parsers)), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'record initial cell lint baseline');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  git(box.root, 'checkout', '-qb', 'candidate');
  return { ...box, main };
}

/** Commit the candidate, then inspect it with the exact native submit guard; counts come from main and the candidate. */
async function inspect(box) {
  await warmAcceptedCells(box.root, box.main, { withCheckout: withMainCheckout, withLock: withFileLock });
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
  cellsMove.apply(cellsMove.plan({ root: box.root, from: 'src/refused.js', to: 'packages/kernel/src/logic/refused.js',
    frontDoor: 'packages/kernel/index.js', purpose: 'Expose the actual fixture refusal class.' }), custody);
}

test('a real cells move may land and its shim is counted from source [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  const commit = await inspect(box);
  git(box.root, 'checkout', '-q', 'main');
  git(box.root, 'merge', '--no-ff', '-qm', 'land actual cells move', commit);
  assert.equal(cellLintReport(box.root, parsers).metrics.shims.count, 1);
  const records = shimLifecycle(box.root, { items: [
    { item_id: 23, item_title: 'Remove kernel shims', item_criterion: 'Delete src/refused.js', item_status: 'open' },
    { item_id: 99, item_title: 'Refuse new shim imports', item_criterion: 'Reject a new import of src/refused.js', item_status: 'open' },
  ] });
  assert.equal(records.length, 1);
  assert.equal(records[0].moveLandedAt, git(box.root, 'log', '-1', '--format=%cI').trim(), 'age starts at the real merge landing');
  assert.equal(records[0].removalItem, 23);
});

test('a stray shim refuses even when the builder updates the count snapshot [C7,CD64]', async t => {
  const box = fixture(t);
  box.put('src/stats-flow.js', "export { stats as flow } from './stats.js';\n");
  await assert.rejects(inspect(box), error => error.code === 'CELLS_SUBMIT' && /shim count rose without a cells move: src\/stats-flow.js/u.test(error.message));
});

test('a cells move submits without any committed shim count snapshot [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  assert.match(await inspect(box), /^[0-9a-f]{40}$/u);
});

test('native health names an aged shim, its cell and the removal item at the configured age [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  const commit = await inspect(box);
  git(box.root, 'checkout', '-q', 'main');
  git(box.root, 'merge', '--no-ff', '-qm', 'land health shim fixture', commit);
  const landed = Date.parse(git(box.root, 'log', '-1', '--format=%cI').trim());
  const board = fixtureBoard(t);
  const removal = addItem(board, { by: 'coordinator', lane: 'core', title: 'Cells shim removal: every importer of kernel uses its front door and the kernel shims are deleted', criterion: 'Delete the cell shims after repointing their importers.' });
  const observe = days => healthReport({ db: board.db, root: box.root,
    config: configFromSource(JSON.stringify({ ...defaults(), cells: { cache: false, shimMaxAgeDays: days } })),
    now: new Date(landed + 8 * 86_400_000), dispatchHealth });
  addItem(board, { by: 'coordinator', lane: 'core', title: 'Remove kernel-extra shims', criterion: 'Delete the other cell shims.' });
  const report = observe(7);
  const finding = report.stuck.find(row => row.cause === 'CELL_SHIM_OVERDUE');
  assert.equal(finding?.subject, 'src/refused.js');
  assert.equal(finding.detail.cell, 'kernel');
  assert.equal(finding.detail.removalItem, removal);
  assert.ok(healthLines(report).some(line => line.includes('src/refused.js') && line.includes(`#${removal}`)));
  assert.equal(observe(9).stuck.some(row => row.cause === 'CELL_SHIM_OVERDUE'), false);
});


test('each shim records its own Git landing when a cell gains a later move [C7,CD64]', async t => {
  const box = fixture(t);
  move(box, t);
  const commit = await inspect(box);
  git(box.root, 'checkout', '-q', 'main');
  git(box.root, 'merge', '--no-ff', '-qm', 'land first history fixture', commit);
  const firstDate = git(box.root, 'log', '-1', '--format=%cI').trim();
  git(box.root, 'checkout', '-qb', 'later-move');
  const source = 'src/stats-flow.js';
  const target = 'packages/kernel/src/logic/stats-flow.js';
  git(box.root, 'mv', source, target);
  box.put(target, readFileSync(join(box.root, target), 'utf8').replace("'./stats.js'", "'../../../../src/stats.js'"));
  box.put(source, "export { flow } from '../../../../packages/kernel/index.js';\n");
  box.put('packages/kernel/index.js', readFileSync(join(box.root, 'packages/kernel/index.js'), 'utf8') + "export { flow } from './src/logic/stats-flow.js';\n");
  const mapFile = 'packages/codemap/data/plan/path-map/kernel.json';
  box.put(mapFile, JSON.stringify({ ...JSON.parse(readFileSync(join(box.root, mapFile))), [source]: target }));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'move another actual module for history observation');
  git(box.root, 'checkout', '-q', 'main');
  const laterDate = new Date(Date.parse(firstDate) + 86_400_000).toISOString();
  runFixtureGit(['merge', '--no-ff', '-qm', 'land later history fixture', 'later-move'], {
    cwd: box.root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Shim history', GIT_AUTHOR_EMAIL: 'history@example.invalid',
      GIT_COMMITTER_NAME: 'Shim history', GIT_COMMITTER_EMAIL: 'history@example.invalid',
      GIT_AUTHOR_DATE: laterDate, GIT_COMMITTER_DATE: laterDate },
  });
  const dates = new Map(shimLifecycle(box.root).map(row => [row.path, Date.parse(row.moveLandedAt)]));
  assert.equal(dates.get('src/refused.js'), Date.parse(firstDate));
  assert.equal(dates.get(source), Date.parse(laterDate), 'a later map row does not inherit the first move date');
});
