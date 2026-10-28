/** @pullboard-test-input source-tree bin/cells-plan.json bin/cells-plan/** */
/** The committed cells move plan places each path once and orders cells leaf-first by real imports [D3,CD60,CD64]. */
import { sourceAdvancePlan } from '../src/source-advance-plan.js';
import { selectAffectedTests } from '../src/affected-tests.js';
import { selectTestTreeGuards } from '../src/affected-tests.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellInventory } from '../src/cell-lint-inventory.js';
import { testFile } from '../src/cell-lint-inventory.js';
import { inPlanScope } from '../src/cells-plan.js';
import { readPathMap } from '../src/path-map.js';
import { mappedPath } from '../src/path-map.js';
import { computePlan } from '../bin/cells-plan.js';
import { refreshPlanCuts } from '../src/cells-plan-cuts.js';
import { checkMoved } from '../bin/cells-plan.js';
import { itemCommands } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { runFixtureChild } from './fixture-child.js';
import { installCutCases } from './cells-plan-cut-cases.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
const PLAN = readPlan(ROOT);

/** Map every file the plan names, at its old path, its target or its committed path-map path, to its cell. */
function cellIndex(plan, map) {
  const index = new Map();
  for (const cell of plan.cells) for (const [from, to] of cell.paths) for (const path of [from, to, mappedPath(map, from)]) index.set(path, cell.name);
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
      assert.ok(to.startsWith(`${cell.root}/src/core/`) || to.startsWith(`${cell.root}/src/shell/`) || to.startsWith(`${cell.root}/tests/`), `${to} sits in ${cell.root}'s anatomy`);
      assert.ok(!targets.has(to), `${to} is the target of ${targets.get(to)} and ${from}`);
      targets.set(to, from);
    }
    assert.ok(cell.item.criterion && cell.item.check === `node bin/cells-plan.js --moved ${cell.name}`, `${cell.name} carries a frozen check`);
  }
  for (const row of PLAN.stays) assert.ok(!owners.has(row.path), `${row.path} both stays and moves`);
  assert.equal(owners.size, PLAN.totals.movedPaths);
  assert.equal(PLAN.cells.length, PLAN.totals.cells);
});

test('the plan places every tracked module and asset under src/, bin/ and relay/ at its base commit [D3,CD60]', () => {
  assert.match(PLAN.base, /^[0-9a-f]{40}$/u, 'the plan records the commit it was computed at');
  const listed = git(ROOT, 'ls-tree', '-r', '--name-only', PLAN.base);
  const placed = new Set([...PLAN.cells.flatMap(cell => cell.paths.map(([from]) => from)), ...PLAN.stays.map(row => row.path)]);
  const missing = listed.split('\n').filter(file => inPlanScope(file) && !placed.has(file));
  assert.deepEqual(missing, [], 'regenerate with node bin/cells-plan.js --write');
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
  assert.ok(checked > 1000, `the real import graph was read (${checked} cross-cell imports)`);
  assert.deepEqual([...ahead], [], 'name the import as a cut of the later cell, or regenerate with node bin/cells-plan.js --write');
  for (const cell of PLAN.cells) {
    for (const name of cell.item.after) assert.ok(position.get(name) < cell.order, `${cell.name} waits only on earlier cells`);
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
  assert.ok(plan.cells.find(cell => cell.name === 'stats').paths.every(([, to]) => to.startsWith('packages/stats/src/shell/')), 'a module reading files is shell');
  assert.equal(plan.cells.find(cell => cell.name === 'kernel').paths[0][1], 'packages/kernel/src/core/refused.js', 'a module with no input or output is core');
  const commands = itemCommands(plan);
  assert.equal(commands.length, plan.cells.length);
  assert.ok(commands.every(({ args }) => args[0] === 'add' && args.includes('--check') && args.includes('--after')), 'each cell becomes one pullboard add with a check and an order');
  const filed = new Map([[plan.cells[0].name, '7001']]);
  const rerun = itemCommands(plan, filed);
  assert.equal(rerun.length, plan.cells.length - 1, 'a rerun skips a cell already on the board');
  const dependent = rerun.find(({ cell }) => cell.item.after.includes(plan.cells[0].name));
  assert.ok(dependent && dependent.args[dependent.args.indexOf('--after') + 1].split(',').includes('7001'), 'a later cell waits on the filed id');
});

test('a move item\'s frozen check passes only when the cell moved behind shims [D3,CD60]', t => {
  const { root, put } = fixture(t);
  const plan = computePlan(root);
  writePlan(root, plan);
  assert.deepEqual(readPlan(root), JSON.parse(JSON.stringify(plan)), 'the sharded plan reads back whole');
  const kernel = plan.cells.find(cell => cell.name === 'kernel');
  assert.ok(checkMoved(root, plan, 'kernel').length > 0, 'an unmoved cell fails its check');
  put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
  put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
  assert.match(checkMoved(root, plan, 'kernel').join('\n'), /src\/refused\.js still holds code/u, 'code left at the old path fails');
  put('src/refused.js', "export { Refused } from '../packages/kernel/src/core/refused.js';\n");
  assert.deepEqual(checkMoved(root, plan, 'kernel'), [], `${kernel.name} moved behind a shim`);
  const run = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const unknown = runFixtureChild(process.execPath, [BIN, '--moved', 'nowhere'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /CELLS_PLAN_CELL/u);
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
  cell.paths.push([path, 'apps/cli/src/core/added-command.js', 'seed']);
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
  put('src/stats-docs-reader.js', "import { readdirSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const docs = (root = '.') => [readdirSync(join(root, 'src', 'stats-docs')), readFileSync];\n");
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
  assert.equal(git(root, 'diff', '--', 'bin/cells-plan.json', 'bin/cells-plan').stdout, '', 'no partial generated writes survive refusal');
});
