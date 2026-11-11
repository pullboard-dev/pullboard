/** @pullboard-test-input source-tree */
/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** The committed cells move plan places each path once and orders cells leaf-first by real imports [D3,CD60,CD64]. */
import { sourceAdvancePlan } from '../../../../../packages/codemap/index.js';
import { withSourceComposition } from '../../../../../packages/merge/index.js';
import { retryReviewCommit } from '../../../../../packages/verify/index.js';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { selectTestTreeGuards } from '../../../../../packages/gate/index.js';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../../packages/gate/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellInventory } from '../../../../../packages/codemap/index.js';
import { testFile } from '../../../../../packages/codemap/index.js';
import { inPlanScope } from '../../../../../packages/codemap/index.js';
import { readPathMap } from '../../../../../packages/codemap/index.js';
import { mappedPath } from '../../../../../packages/codemap/index.js';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { refreshPlanCuts } from '../../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { itemCommands } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { readPlan } from '../../../../../packages/codemap/index.js';
import { stalePlanRows } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { orphanCutEdges } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { importCuts } from '../../../../../packages/codemap/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { installCutCases } from '../../../tests/fixtures/cells/cases.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import {
  mechanicalConflictFiles,
  resolveMechanicalIndex,
} from '../../../../../packages/merge/index.js';
import { formatJson } from '../../../../../packages/codemap/index.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const BIN = fileURLToPath(new URL('../../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const PLAN = readPlan(ROOT);

/** Map every file the plan names, at its old path, its target or its committed path-map path, to its cell. */
function cellIndex(plan, map) {
  const index = new Map();
  for (const cell of plan.cells) for (const [from, to] of cell.paths) for (const path of [from, to, mappedPath(map, from)]) index.set(path, cell.name);
  for (const entry of plan.entries ?? []) index.set(entry.path, entry.cell);
  return index;
}

test('every moved path in the committed plan is in exactly one cell, with one target inside that cell [D3,CD60]', () => {
  const owners = new Map(), targets = new Map();
  for (const cell of PLAN.cells) {
    assert.equal(cell.frontDoor, `${cell.root}/index.js`, `${cell.name} has one front door`);
    assert.match(cell.name.replace(/^app:/u, ''), /^[a-z]+$/u, `${cell.name} is one lowercase word [CD14]`);
    for (const [from, to] of cell.paths) {
      assert.ok(!owners.has(from), `${from} is in ${owners.get(from)} and ${cell.name}`);
      owners.set(from, cell.name);
      assert.ok(['src/logic/', 'src/io/', 'tests/', 'data/'].some(folder => to.startsWith(`${cell.root}/${folder}`)), `${to} sits in ${cell.root}'s anatomy`);
      assert.ok(!targets.has(to), `${to} is the target of ${targets.get(to)} and ${from}`);
      targets.set(to, from);
    }
    // A finished cell carries no paths and no item: its move landed and its rows left the plan with it.
    if (cell.paths.length === 0) assert.equal(cell.item, undefined, `${cell.name} finished, so it carries no item`);
    else assert.ok(cell.item.criterion && cell.item.check === `node packages/codemap/src/io/cells/scripts/plan.js --moved ${cell.name}`, `${cell.name} carries a frozen check`);
  }
  // A rule 6 shim stays at its old path as the front door and its body moves: that row is both by design.
  for (const row of PLAN.stays) assert.ok(!owners.has(row.path) || /^rule 6 shim\b/u.test(row.reason), `${row.path} both stays and moves`);
  assert.equal(owners.size, PLAN.totals.movedPaths);
  assert.equal(PLAN.cells.length, PLAN.totals.cells);
});

test('no active plan row names a file deleted since the plan, so a later move never looks for it [C7,D3]', () => {
  const stale = stalePlanRows(ROOT, PLAN).map(({ file, row }) => `${file}: ${row[0]}`);
  assert.deepEqual(stale, [], 'retire each deleted file in the item that deletes it: node packages/codemap/src/io/cells/scripts/plan.js --retire <path>');
});

test('no cut edge names a file without a plan row, so the cut reader and the submit gate never refuse main [C7,D3]', () => {
  assert.deepEqual(orphanCutEdges(PLAN), [], 'a shim item drops its cut edges too: node packages/codemap/src/io/cells/scripts/plan.js --retire <path>');
  assert.doesNotThrow(() => importCuts(PLAN));
});

test('the plan places every tracked module and asset under src/, bin/ and relay/ at its base commit [D3,CD60]', () => {
  assert.match(PLAN.base, /^[0-9a-f]{40}$/u, 'the plan records the commit it was computed at');
  const listed = new Set(git(ROOT, 'ls-tree', '-r', '--name-only', PLAN.base).split('\n'));
  const rows = PLAN.cells.flatMap(cell => cell.paths.map(([from]) => from));
  assert.deepEqual(rows.filter(file => !listed.has(file)), [], 'a moved row names a file its base commit does not hold');
  const stays = new Set(PLAN.stays.map(row => row.path));
  const left = git(ROOT, 'ls-files').split('\n').filter(file => inPlanScope(file) && !stays.has(file));
  assert.deepEqual(left, [], 'the freeze moved every module and asset out of the old roots; place a new one under its cell, not at the root');
});

test('no cell is ordered ahead of a cell it imports, computed from the real source, except the cuts it names [D3,CD64]', () => {
  const { edges } = cellInventory(ROOT, { importsIn, commonJsIn });
  const index = cellIndex(PLAN, readPathMap(ROOT));
  const position = new Map(PLAN.cells.map(cell => [cell.name, cell.order]));
  const cuts = new Set(PLAN.cells.flatMap(cell => cell.cuts.map(row => `${row.cell}->${cell.name}`)));
  const ahead = new Set();
  let checked = 0;
  for (const [file, rows] of edges) for (const { target } of rows) {
    if (testFile(file) || testFile(target)) continue;
    const from = index.get(file), to = index.get(target);
    if (!from || !to || from === to) continue;
    checked++;
    if (position.get(to) > position.get(from) && !cuts.has(`${from}->${to}`)) ahead.add(`${from} (move ${position.get(from)}) imports ${to} (move ${position.get(to)}) through ${file} -> ${target}`);
  }
  const crossCellEdges = [...edges].flatMap(([file, rows]) => testFile(file) ? []
    : rows.filter(({ target }) => !testFile(target) && index.has(file) && index.has(target) && index.get(file) !== index.get(target)));
  assert.ok(crossCellEdges.length > 0, 'the real inventory contains cross-cell imports');
  assert.equal(checked, crossCellEdges.length, 'the order check visits every cross-cell import in the inventory');
  assert.deepEqual([...ahead], [], 'name the import as a cut of the later cell, or regenerate with node packages/codemap/src/io/cells/scripts/plan.js --write');
  for (const cell of PLAN.cells) {
    for (const name of cell.item?.after ?? []) assert.ok(position.get(name) < cell.order, `${cell.name} waits only on earlier cells`);
    if (!cell.name.startsWith('app:')) assert.ok(PLAN.cells.filter(other => other.name.startsWith('app:')).every(app => app.order > cell.order), `package ${cell.name} moves before every app`);
  }
});

test('a plan built from real files orders leaves first, cuts the cycle and places a newer module by name [D3,CD60,CD64]', t => {
  const { root } = fixture(t);
  const plan = computePlan(root);
  const names = plan.cells.map(cell => cell.name);
  assert.deepEqual(names.slice(0, 1), ['kernel'], 'the cell that imports nothing moves first');
  assert.equal(names.at(-1), 'app:cli', 'the app moves after every package');
  assert.ok(names.indexOf('stats') > names.indexOf('store'), 'stats moves after the store it imports');
  const store = plan.cells.find(cell => cell.name === 'store'), items = plan.cells.find(cell => cell.name === 'items');
  const later = store.order > items.order ? store : items, earlier = later === store ? items : store;
  assert.deepEqual(later.cuts.map(row => row.cell), [earlier.name], 'the store and items cycle becomes one named cut');
  assert.equal(plan.cells.find(cell => cell.name === 'stats').paths.find(([from]) => from === 'src/stats-flow.js')?.[2], 'rule', 'the newer stats-flow module joins stats by the dry run name rule');
  assert.deepEqual(plan.stays.map(row => row.path), ['bin/tool.js']);
  const statsPaths = plan.cells.find(cell => cell.name === 'stats').paths;
  assert.ok(statsPaths.find(([from]) => from === 'src/stats.js')?.[1].startsWith('packages/stats/src/io/'), `a module reading files is io: ${JSON.stringify(statsPaths)}`);
  assert.ok(statsPaths.find(([from]) => from === 'src/stats-flow.js')?.[1].startsWith('packages/stats/src/io/'), `a pure module that imports an io module of its cell is io too [CD36]: ${JSON.stringify(statsPaths)}`);
  assert.equal(plan.cells.find(cell => cell.name === 'kernel').paths[0][1], 'packages/kernel/src/logic/refused.js', 'a module with no input or output is core');
  const commands = itemCommands(plan);
  assert.equal(commands.length, plan.cells.length);
  assert.ok(commands.every(({ args }) => args[0] === 'add' && args.includes('--check') && args.includes('--after')), 'each cell becomes one pullboard add with a check and an order');
  assert.ok(commands.every(({ cell, args }) => args[args.indexOf('--brief') + 1].includes(`Shims re-export through ${cell.frontDoor}, never a moved leaf directly`)), 'the move brief names the required front door');
  const filed = new Map([[plan.cells[0].name, '7001']]);
  const rerun = itemCommands(plan, filed);
  assert.equal(rerun.length, plan.cells.length - 1, 'a rerun skips a cell already on the board');
  const dependent = rerun.find(({ cell }) => cell.item.after.includes(plan.cells[0].name));
  assert.ok(dependent && dependent.args[dependent.args.indexOf('--after') + 1].split(',').includes('7001'), 'a later cell waits on the filed id');
});

test('a move item\'s frozen check passes only when the cell moved behind shims [D3,CD60]', t => {
  const { root, put } = fixture(t);
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root);
  writePlan(root, plan);
  assert.deepEqual(readPlan(root), JSON.parse(JSON.stringify(plan)), 'the sharded plan reads back whole');
  const kernel = plan.cells.find(cell => cell.name === 'kernel');
  assert.ok(checkMoved(root, plan, 'kernel').length > 0, 'an unmoved cell fails its check');
  put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  assert.match(checkMoved(root, plan, 'kernel').join('\n'), /src\/refused\.js still holds code/u, 'code left at the old path fails');
  put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  assert.deepEqual(checkMoved(root, plan, 'kernel'), [], `${kernel.name} moved behind a shim`);
  const run = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const unknown = runFixtureChild(process.execPath, [BIN, '--moved', 'nowhere'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /CELLS_PLAN_CELL/u);
});

test('a moved shim that bypasses its unreachable front door fails by both paths [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root);
  writePlan(root, plan);
  put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/light.js';\n");
  const problems = checkMoved(root, plan, 'kernel');
  assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door packages/kernel/index.js')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('unreachable front door packages/kernel/index.js')), problems.join('\n'));
  const run = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /src\/refused\.js.*packages\/kernel\/index\.js/u);
});

test('only exact named own-body worker shims pass the bounded process-entry exception [C7,D3,CD64]', t => {
  for (const mode of ['worker', 'non-worker', 'wrong-leaf', 'star', 'opaque', 'oversize']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js', files: ['package.json', 'src/**', 'packages/**'] }));
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    const leaf = mode === 'wrong-leaf' ? 'other' : 'refused';
    const bindings = mode === 'star' ? '*' : '{ Refused }';
    put('src/refused.js', `export ${bindings} from '../packages/kernel/src/logic/${leaf}.js';\n`);
    let worker = mode === 'non-worker' ? 'export const worker = true;\n' : "import { Refused } from './refused.js';\nexport const worker = Refused;\n";
    if (mode === 'opaque') worker += 'new URL(process.env.UNKNOWN_WORKER_PATH, import.meta.url);\n';
    if (mode === 'oversize') worker += `export const padding = '${'x'.repeat(1_048_576)}';\n`;
    put('apps/runner/src/io/scripts/worker.js', worker);
    const problems = checkMoved(root, plan, 'kernel');
    if (mode === 'worker') assert.deepEqual(problems, [], 'a closed actual worker may retain its exact named own-body shim');
    else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});

test('only exact named own-body move shims pass the bounded move-registry exception [C7,D3,CD64]', t => {
  for (const mode of ['move', 'outside', 'wrong-leaf', 'star', 'opaque', 'oversize']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js', files: ['package.json', 'src/**', 'packages/**'] }));
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    const leaf = mode === 'wrong-leaf' ? 'other' : 'refused';
    const bindings = mode === 'star' ? '*' : '{ Refused }';
    put('src/refused.js', `export ${bindings} from '../packages/kernel/src/logic/${leaf}.js';\n`);
    put('apps/runner/src/io/scripts/worker.js', 'export const worker = true;\n');
    let move = mode === 'outside' ? 'export const move = true;\n'
      : "import { Refused } from '../refused.js';\nexport const move = Refused;\n";
    if (mode === 'opaque') move += 'await import(process.env.UNKNOWN_MOVE_PATH);\n';
    if (mode === 'oversize') move += `export const padding = '${'x'.repeat(1_048_576)}';\n`;
    put('src/moves/fixtureMove.js', move);
    const problems = checkMoved(root, plan, 'kernel');
    if (mode === 'move') assert.deepEqual(problems, [], 'an actual bounded move closure retains its exact named own-body shim');
    else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});

test('a correct shim does not make an otherwise unreachable moved package reachable [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root);
  writePlan(root, plan);
  put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  put('src/board.js', "import { claims } from './claims.js';\nexport const board = () => claims;\n");
  assert.ok(checkMoved(root, plan, 'kernel').some(problem => problem.includes('unreachable front door packages/kernel/index.js')));
});


installCutCases({ PLAN, BIN, fixture, git });


test('a bounded single-entry write derives index and shard counts from the same paths [C7,D3,CD60]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  const before = readPlan(root);
  const bounded = readPlan(root);
  const cell = bounded.cells.find(row => row.name === 'app:cli');
  const path = 'src/added-command.js';
  put(path, 'export const bounded = true;\n');
  cell.paths.push([path, 'apps/cli/src/logic/added-command.js', 'seed']);
  // Deliberately leave both cached summaries unchanged, as the real #1632 bounded caller did.
  assert.equal(bounded.totals.movedPaths, before.totals.movedPaths);
  assert.deepEqual(cell.placedBy, before.cells.find(row => row.name === cell.name).placedBy);
  writePlan(root, bounded);
  const after = readPlan(root);
  assert.equal(after.totals.movedPaths, before.totals.movedPaths + 1);
  assert.equal(after.totals.movedPaths, after.cells.reduce((sum, row) => sum + row.paths.length, 0));
  assert.equal(after.totals.placedBy.seed, before.totals.placedBy.seed + 1);
  assert.equal(after.cells.find(row => row.name === cell.name).placedBy.seed, cell.placedBy.seed + 1);
  assert.deepEqual(after.cells.find(row => row.name === cell.name).paths, cell.paths, 'path order and exact targets survive');
  for (const row of after.cells) {
    const original = before.cells.find(previous => previous.name === row.name);
    const { paths, placedBy, ...semantics } = row;
    const { paths: oldPaths, placedBy: oldPlacement, ...oldSemantics } = original;
    assert.deepEqual(semantics, oldSemantics, 'cuts, ratchets, item contracts and ordering are not regenerated');
    if (row.name !== cell.name) assert.deepEqual(row, original, 'unrelated shards remain unchanged');
  }
  for (const field of ['base', 'seed', 'names', 'stays']) assert.deepEqual(after[field], before[field], `${field} provenance is retained`);
  writePlan(root, after);
  assert.deepEqual(readPlan(root), after, 'the normalized writer is idempotent');
});

test('an asset a placed reader lists joins that reader cell, and an asset nothing reads is still refused by name [D3,CD60]', t => {
  const { root, put } = fixture(t);
  put('src/stats-docs/heartbeat.json', '{}\n');
  put('src/stats-docs-reader.js', "import { readdirSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const docs = (root = '.') => [readdirSync(join(root, 'src/stats-docs')), readFileSync];\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'directory reader');
  const plan = computePlan(root);
  const row = plan.cells.find(cell => cell.name === 'stats').paths.find(([from]) => from === 'src/stats-docs/heartbeat.json');
  assert.equal(row?.[2], 'rule', 'the asset joins the stats cell that lists its directory');
  put('src/orphan/unread.json', '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'unread asset');
  assert.throws(() => computePlan(root), error => error.code === 'CELLS_UNPLACED' && error.message.includes('src/orphan/unread.json'));
});

/** Real Git graph selection remains explicit, while missing parsers/selectors refuse before repository reads. */
test('codemap providers are required and source advance retains its real raw closure [C7,D3,CD64]', t => {
  for (const parsers of [undefined, { importsIn }, { commonJsIn }]) {
    assert.throws(() => cellInventory('/missing-codemap-provider', parsers), /explicit module parser operations/u);
  }
  const config = { affectedTests: 'node --test --test-reporter=tap', gate: 'npm run gate', registryGuards: [], submitInvariants: [] };
  for (const selectors of [undefined, { selectAffectedTests }, { selectTestTreeGuards }]) {
    assert.throws(() => sourceAdvancePlan('/missing-codemap-provider', config, { base: 'HEAD', changed: [] }, selectors), /explicit test selector operations/u);
  }
  const { root, put } = fixture(t);
  put('test/selected.test.js', "import { stats } from '../src/stats.js';\nimport { test } from 'node:test';\ntest('selected real graph', () => stats());\n");
  put('test/unrelated.test.js', "import { test } from 'node:test';\ntest('unrelated actual test', () => {});\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture: actual test importer');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const plan = sourceAdvancePlan(root, config, { base, changed: ['src/stats.js'], check: 'node --test test/selected.test.js' }, { selectAffectedTests, selectTestTreeGuards });
  assert.equal(plan.selection.full, false);
  assert.deepEqual(plan.proofFiles, ['test/selected.test.js']);
  assert.equal(plan.criterion, 'node --test test/selected.test.js');
  assert.equal(plan.affected, "node --test --test-reporter=tap './test/selected.test.js'");
  assert.match(plan.selectionDigest, /^[a-f0-9]{64}$/u);
});


test('cut metadata refresh preserves frozen moves and records only current real source edges [D3,CD64]', t => {
  const { root, put } = fixture(t), plan = computePlan(root);
  const early = plan.cells.find(cell => cell.name === 'kernel'), later = plan.cells.find(cell => cell.name === 'stats');
  const before = structuredClone(plan);
  writePlan(root, plan);
  put('src/refused.js', "import { stats } from './stats.js';\nexport class Refused extends Error {}\nexport const probe = stats;\n");
  put('test/probe.test.js', "import '../src/stats.js';\n");
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'new actual source edge');
  const { edges } = cellInventory(root, { importsIn, commonJsIn });
  const refreshed = refreshPlanCuts(plan, edges, readPathMap(root));
  const run = runFixtureChild(process.execPath, [BIN, '--refresh-cuts'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readPlan(root).cells, refreshed.cells, 'the real generator command writes the exact bounded refresh');
  assert.deepEqual(plan, before, 'the reader does not mutate its input');
  assert.deepEqual(refreshed.cells.map(({ cuts, ...cell }) => cell), plan.cells.map(({ cuts, ...cell }) => cell),
    'order, numbering, paths, frozen item fields and every non-cut cell field remain exact');
  const cut = refreshed.cells.find(cell => cell.name === later.name).cuts.find(row => row.cell === early.name);
  assert.deepEqual(cut, { cell: early.name, imports: 1, edges: ['src/refused.js->src/stats.js'] });
  assert.ok(refreshed.cells.every(cell => cell.cuts.every(row => row.edges.every(edge => !edge.includes('test/probe')))), 'test imports do not create source cuts');
  put('src/refused.js', 'await import(globalThis.destination);\nexport class Refused extends Error {}\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'unresolved source dependency');
  const uncertain = cellInventory(root, { importsIn, commonJsIn });
  assert.ok(uncertain.unknown.some(row => row.file === 'src/refused.js'));
  const retained = refreshPlanCuts(refreshed, uncertain.edges, readPathMap(root), uncertain.unknown);
  assert.deepEqual(retained.cells.find(cell => cell.name === later.name).cuts.find(row => row.cell === early.name), cut,
    'an unresolved loader cannot erase a previously recorded cut');
  put('src/refused.js', 'export class Refused extends Error {}\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'remove actual edge');
  const removed = refreshPlanCuts(refreshed, cellInventory(root, { importsIn, commonJsIn }).edges, readPathMap(root));
  assert.ok(!removed.cells.find(cell => cell.name === later.name).cuts.some(row => row.cell === early.name), 'removed source edges cannot remain authorized cuts');
});


test('cut refresh refuses a newly tracked unplanned endpoint without changing any plan bytes [C7,D3,CD64]', t => {
  const { root, put } = fixture(t), plan = computePlan(root);
  writePlan(root, plan);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'frozen fixture plan');
  put('src/unplanned-provider.js', 'export const provider = 1;\n');
  put('src/refused.js', "import { provider } from './unplanned-provider.js';\nexport class Refused extends Error {}\n");
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'unplanned real endpoint');
  const run = runFixtureChild(process.execPath, [BIN, '--refresh-cuts'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'an unowned endpoint cannot silently disappear from refreshed cuts');
  assert.match(run.stderr, /CELLS_PLAN_UNPLANNED.*src\/unplanned-provider\.js/su);
  assert.deepEqual(readPlan(root), plan, 'refusal preserves the exact prior plan');
  assert.equal(git(root, 'diff', '--', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan'), '', 'no partial generated writes survive refusal');
});

/** Two branches off one commit that each change the same file, merged in the given order into a real conflict. */
function divergent(t, file, base, left, right) {
  const { root, put } = fixture(t);
  git(root, 'config', 'user.name', 'Cells plan fixture');
  git(root, 'config', 'user.email', 'cells@example.invalid');
  put(file, base); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const main = git(root, 'rev-parse', 'HEAD').trim();
  const branch = (name, source) => {
    git(root, 'checkout', '-q', '-b', name, main); put(file, source); git(root, 'commit', '-qam', name);
    return git(root, 'rev-parse', 'HEAD').trim();
  };
  const heads = [branch('left', left), branch('right', right)];
  git(root, 'checkout', '-q', 'left');
  return { root, heads };
}

const SHARD = (paths) => formatJson({ order: 8, name: 'state', paths }) + '\n';
const ROW = (n) => [`src/m-${n}.js`, `packages/state/src/m-${n}.js`, 'rule'];
const SHARD_FILE = 'packages/codemap/data/plan/14-state.json';

test('two disjoint plan-row appends merge clean in both orders and keep the one-row-per-line layout [C7,D3]', t => {
  const base = [ROW(1), ROW(2)];
  const { root, heads } = divergent(t, SHARD_FILE, SHARD(base), SHARD([...base, ROW(3)]), SHARD([...base, ROW(4)]));
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    assert.deepEqual(mechanicalConflictFiles(root, ours, theirs), [], 'git alone conflicts on the shared tail; the mechanical merge does not');
    git(root, 'checkout', '-q', '--detach', ours);
    try { git(root, 'merge', '--no-commit', '--no-ff', theirs); } catch { /* git alone reports the conflict */ }
    assert.deepEqual(resolveMechanicalIndex(root, [SHARD_FILE]).files, []);
    const rows = JSON.parse(readFileSync(join(root, SHARD_FILE), 'utf8')).paths;
    assert.deepEqual(rows.map(row => row[0]).sort(), ['src/m-1.js', 'src/m-2.js', 'src/m-3.js', 'src/m-4.js']);
    assert.equal(readFileSync(join(root, SHARD_FILE), 'utf8'), formatJson(JSON.parse(readFileSync(join(root, SHARD_FILE), 'utf8'))) + '\n', 'one row per line, as the plan writer lays it out');
    git(root, 'merge', '--abort');
  }
});

test('the same plan row edited two ways still conflicts [C7,D3]', t => {
  const base = [ROW(1), ROW(2)];
  const edit = (to) => base.map(row => (row[0] === 'src/m-2.js' ? ['src/m-2.js', to, 'rule'] : row));
  const { root, heads } = divergent(t, SHARD_FILE, SHARD(base), SHARD(edit('packages/a/m-2.js')), SHARD(edit('packages/b/m-2.js')));
  assert.deepEqual(mechanicalConflictFiles(root, heads[0], heads[1]), [SHARD_FILE]);
  const added = divergent(t, SHARD_FILE, SHARD(base), SHARD([...base, ['src/m-9.js', 'packages/a/m-9.js', 'rule']]), SHARD([...base, ['src/m-9.js', 'packages/b/m-9.js', 'rule']]));
  assert.deepEqual(mechanicalConflictFiles(added.root, added.heads[0], added.heads[1]), [SHARD_FILE], 'one new path placed in two cells is a real conflict');
});

const DEFAULTS = (extra = '') => `export function defaults() {
  return {
    spec: 'SPEC.md',
    // Explains the next setting.
    map: { slice: false },${extra}
    lanes: {},
    commits: {
      maxHeader: 72,
    },
  };
}
`;

test('different keys added to the config defaults merge clean in both orders; one key edited twice conflicts [C7]', t => {
  const mapped = DEFAULTS().replace('    lanes: {},', '    alpha: { on: false },\n    lanes: {},');
  const beta = DEFAULTS().replace('    spec: ', "    // Beta's comment.\n    beta: {\n      on: true,\n    },\n    spec: ");
  const { root, heads } = divergent(t, 'src/config.js', DEFAULTS(), mapped, beta);
  for (const [ours, theirs] of [heads, [...heads].reverse()]) assert.deepEqual(mechanicalConflictFiles(root, ours, theirs), []);
  const edited = divergent(t, 'src/config.js', DEFAULTS(), DEFAULTS().replace('slice: false', 'slice: true'), DEFAULTS().replace('slice: false', 'slice: 1'));
  assert.deepEqual(mechanicalConflictFiles(edited.root, edited.heads[0], edited.heads[1]), ['src/config.js']);
  const twice = divergent(t, 'src/config.js', DEFAULTS(), mapped, mapped.replace('false },\n    lanes', 'true },\n    lanes'));
  assert.deepEqual(mechanicalConflictFiles(twice.root, twice.heads[0], twice.heads[1]), ['src/config.js'], 'the same new key with two values is a real conflict');
});

test('a plan row one branch deletes and the other changes still conflicts in both orders [C7,D3]', t => {
  const base = [ROW(1), ROW(2)];
  const gone = base.filter(row => row[0] !== 'src/m-2.js');
  const moved = base.map(row => (row[0] === 'src/m-2.js' ? ['src/m-2.js', 'packages/b/m-2.js', 'rule'] : row));
  const { root, heads } = divergent(t, SHARD_FILE, SHARD(base), SHARD(gone), SHARD(moved));
  assert.deepEqual(mechanicalConflictFiles(root, heads[0], heads[1]), [SHARD_FILE]);
  assert.deepEqual(mechanicalConflictFiles(root, heads[1], heads[0]), [SHARD_FILE]);
  const apart = divergent(t, SHARD_FILE, SHARD(base), SHARD(gone), SHARD([...base, ROW(3)]));
  assert.deepEqual(mechanicalConflictFiles(apart.root, apart.heads[0], apart.heads[1]), [], 'a delete beside a disjoint append still merges');
});

test('a config default one branch deletes and the other changes still conflicts in both orders [C7]', t => {
  const gone = DEFAULTS().replace('    // Explains the next setting.\n    map: { slice: false },\n', '');
  const changed = DEFAULTS().replace('slice: false', 'slice: true');
  assert.notEqual(gone, DEFAULTS());
  const { root, heads } = divergent(t, 'src/config.js', DEFAULTS(), gone, changed);
  assert.deepEqual(mechanicalConflictFiles(root, heads[0], heads[1]), ['src/config.js']);
  assert.deepEqual(mechanicalConflictFiles(root, heads[1], heads[0]), ['src/config.js']);
});

test('replay of a version-three receipt keeps the older policy for plan rows [H16,C7]', t => {
  const base = [ROW(1), ROW(2)];
  const edit = (to) => base.map(row => (row[0] === 'src/m-2.js' ? ['src/m-2.js', to, 'rule'] : row));
  const { root, heads } = divergent(t, SHARD_FILE, SHARD(base), SHARD(edit('packages/a/m-2.js')), SHARD(edit('packages/b/m-2.js')));
  assert.deepEqual(mechanicalConflictFiles(root, heads[0], heads[1], { version: 3 }), [], 'the recorded version-three answer is unchanged');
  assert.deepEqual(mechanicalConflictFiles(root, heads[0], heads[1], { version: 4 }), [SHARD_FILE]);
});

test('moved shim exceptions require a live edge or trusted historical import [C7,D3,CD64]', t => {
  for (const mode of ['live', 'expired', 'history', 'uncommitted-history', 'unreferenced', 'wrong-leaf']) {
    const { root, put } = fixture(t);
    put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
    if (mode === 'history') {
      put('packages/state/data/history/152.json', JSON.stringify({ version: 1, engine: 152, declarations: { 'fixtureMove.js': "import '../refused.js';\n" } }));
      git(root, 'add', 'packages/state/data/history/152.json');
      git(root, 'commit', '-q', '-m', 'seal history');
    }
    const plan = computePlan(root);
    writePlan(root, plan);
    put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/src/logic/other.js', 'export class Refused extends Error {}\n');
    put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    put('src/board.js', "import { Refused } from '../packages/kernel/index.js';\nexport const board = () => Refused;\n");
    put('src/refused.js', `export { Refused } from '../packages/kernel/src/logic/${mode === 'wrong-leaf' ? 'other' : 'refused'}.js';\n`);
    if (['live', 'expired', 'wrong-leaf'].includes(mode)) put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'packages/kernel/src/logic/refused.js', contractItem: 42, expires: mode === 'expired' ? '2000-01-01' : '2999-01-01' }] }));
    if (mode === 'uncommitted-history') put('packages/state/data/history/152.json', JSON.stringify({ version: 1, engine: 152, declarations: { 'fixtureMove.js': "import '../refused.js';\n" } }));
    const notes = [], problems = checkMoved(root, plan, 'kernel', { notes });
    if (mode === 'live' || mode === 'history') {
      assert.deepEqual(problems, [], `${mode}: ${problems.join('\n')}`);
      assert.match(notes.join('\n'), mode === 'live' ? /live temporary edge #42/u : /sealed move history/u);
    } else assert.ok(problems.some(problem => problem.includes('src/refused.js bypasses front door')), `${mode}: ${problems.join('\n')}`);
  }
});


/** Render the plan index's actual keyed placement rows. */
function planIndex(stays) {
  const engineStays = stays.map(({ path, reason }) => ({ cell: 'state', row: [path, 'packages/state/' + path, reason] }));
  return JSON.stringify({ version: 1, cells: [], stays, engineStays }, null, 2) + '\n';
}

/** Render the test-tier manifest's actual file-keyed rows. */
function tierManifest(files) { return JSON.stringify({ version: 1, files }, null, 2) + '\n'; }


test('plan index disjoint additions compose identically in both orders [C7,D3]', async t => {
  const row = path => ({ path: path, reason: 'T1' });
  const base = [row('test/base.test.js')];
  const { root, heads } = divergent(t, 'packages/codemap/data/plan/cells.json', planIndex(base),
    planIndex([...base, row('test/zeta.test.js')]), planIndex([...base, row('test/alpha.test.js')]));
  const sources = [];
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await withSourceComposition(root, ours, theirs, async composition => {
      const source = readFileSync(join(composition.directory, 'packages/codemap/data/plan/cells.json'), 'utf8');
      const document = JSON.parse(source), rows = document.stays;
      assert.deepEqual(document.engineStays.map(entry => entry.row[0]), ['test/alpha.test.js', 'test/base.test.js', 'test/zeta.test.js']);
      assert.deepEqual(rows.map(entry => entry.path), ['test/alpha.test.js', 'test/base.test.js', 'test/zeta.test.js']);
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head);
      sources.push(source);
    });
    const review = retryReviewCommit(root, ours, { commit: theirs });
    assert.equal(git(root, 'show', `${review}:packages/codemap/data/plan/cells.json`) + '\n', sources.at(-1), 'review admission uses the same deterministic data merge');
  }
  assert.equal(sources.length, 2);
  assert.equal(sources[0], sources[1], 'merge direction cannot change the generated manifest bytes');
});

test('plan index same-row edits refuse and name the row [C7,D3]', async t => {
  const path = 'test/shared.test.js';
  const row = value => [{ path: path, reason: value }];
  const { root, heads } = divergent(t, 'packages/codemap/data/plan/cells.json', planIndex(row('T1')),
    planIndex(row('T2')), planIndex(row('T3')));
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await assert.rejects(withSourceComposition(root, ours, theirs, async () => {
      assert.fail('a conflicting row must not reach the composed-source controller');
    }), error => error.code === 'MERGE_CONFLICT' && error.message.includes(path));
    assert.throws(() => retryReviewCommit(root, ours, { commit: theirs }),
      error => error.code === 'MERGE_CONFLICT' && error.message.includes(path));
  }
});


test('test tiers disjoint additions compose identically in both orders [C7,D3]', async t => {
  const row = path => ({ file: path, tier: 'T1' });
  const base = [row('test/base.test.js')];
  const { root, heads } = divergent(t, 'packages/gate/data/tests/tiers.json', tierManifest(base),
    tierManifest([...base, row('test/zeta.test.js')]), tierManifest([...base, row('test/alpha.test.js')]));
  const sources = [];
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await withSourceComposition(root, ours, theirs, async composition => {
      const source = readFileSync(join(composition.directory, 'packages/gate/data/tests/tiers.json'), 'utf8');
      const rows = JSON.parse(source).files;
      assert.deepEqual(rows.map(entry => entry.file), ['test/alpha.test.js', 'test/base.test.js', 'test/zeta.test.js']);
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head);
      sources.push(source);
    });
    const review = retryReviewCommit(root, ours, { commit: theirs });
    assert.equal(git(root, 'show', `${review}:packages/gate/data/tests/tiers.json`) + '\n', sources.at(-1), 'review admission uses the same deterministic data merge');
  }
  assert.equal(sources.length, 2);
  assert.equal(sources[0], sources[1], 'merge direction cannot change the generated manifest bytes');
});

test('test tiers same-row edits refuse and name the row [C7,D3]', async t => {
  const path = 'test/shared.test.js';
  const row = value => [{ file: path, tier: value }];
  const { root, heads } = divergent(t, 'packages/gate/data/tests/tiers.json', tierManifest(row('T1')),
    tierManifest(row('T2')), tierManifest(row('T3')));
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await assert.rejects(withSourceComposition(root, ours, theirs, async () => {
      assert.fail('a conflicting row must not reach the composed-source controller');
    }), error => error.code === 'MERGE_CONFLICT' && error.message.includes(path));
    assert.throws(() => retryReviewCommit(root, ours, { commit: theirs }),
      error => error.code === 'MERGE_CONFLICT' && error.message.includes(path));
  }
});
