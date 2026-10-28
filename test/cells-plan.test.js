/** @pullboard-test-input source-tree bin/cells-plan.json bin/cells-plan/** */
/** The committed cells move plan places each path once and orders cells leaf-first by real imports [D3,CD60,CD64]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cellInventory } from '../src/cell-lint-inventory.js';
import { testFile } from '../src/cell-lint-inventory.js';
import { inPlanScope } from '../src/cells-plan.js';
import { readPathMap } from '../src/path-map.js';
import { mappedPath } from '../src/path-map.js';
import { computePlan } from '../bin/cells-plan.js';
import { checkMoved } from '../bin/cells-plan.js';
import { itemCommands } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { runFixtureChild } from './fixture-child.js';
import { runFixtureGit } from './fixture-child.js';
import { installCutCases } from './cells-plan-cut-cases.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
const PLAN = readPlan(ROOT);

/** Git for this checkout or a fixture, never steered by a caller's GIT_* variables. */
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return runFixtureGit(args, { cwd, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cells plan fixture', GIT_AUTHOR_EMAIL: 'cells@example.invalid', GIT_COMMITTER_NAME: 'Cells plan fixture', GIT_COMMITTER_EMAIL: 'cells@example.invalid' } });
}

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
  const { edges } = cellInventory(ROOT);
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

/** Build a small real repository: three packages in a chain, a two-cell cycle and one module newer than the seed. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cells-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write one file beneath the fixture. */
  const put = (file, source) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); };
  put('package.json', JSON.stringify({ type: 'module' }));
  put('src/refused.js', 'export class Refused extends Error {}\n');
  put('src/board.js', "import { Refused } from './refused.js';\nimport { claims } from './claims.js';\nexport const board = () => [Refused, claims];\n");
  put('src/claims.js', "import { board } from './board.js';\nexport const claims = () => board;\n");
  put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync];\n");
  put('src/stats-flow.js', "import { stats } from './stats.js';\nexport const flow = () => stats;\n");
  put('src/cli.js', "import { stats } from './stats.js';\nimport { flow } from './stats-flow.js';\nconsole.log(stats, flow);\n");
  put('bin/tool.js', "import '../src/cli.js';\n");
  put('bin/cells-plan/seed.json', JSON.stringify({ source: 'fixture', sha256: 'none', order: ['kernel', 'store', 'items', 'stats', 'app:cli'],
    cells: { kernel: ['src/refused.js'], store: ['src/board.js'], items: ['src/claims.js'], stats: ['src/stats.js'], 'app:cli': ['src/cli.js'] }, tests: {} }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, put };
}

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
