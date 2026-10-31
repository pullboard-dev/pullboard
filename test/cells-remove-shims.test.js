/** @pullboard-test-input source-tree */
/** One command removes a cell's shims: repoint, delete, keep what would cut upward, and change nothing the second time [C7,D3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { computePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { removeShims } from '../bin/cells-remove-shims.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';
import { fixture } from './cells-plan-fixture.js';
import { CONFIG } from './cells-remove-shims-read.js';
import { readFixture } from './cells-remove-shims-read.js';
import { git } from './cells-plan-fixture.js';

const PARSERS = { importsIn, commonJsIn };
const TOOL = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
const SEED = { source: 'fixture', sha256: 'none', order: ['kernel', 'stats', 'mid', 'late', 'app:cli'],
  cells: { kernel: ['src/refused.js'], stats: ['src/stats.js'], mid: ['src/mid.js'], late: ['src/late.js'], 'app:cli': ['src/cli.js'] }, tests: {} };

/** A stats cell already moved behind shims, with one importer of every kind and one that would cut upward. */
function shimmed(t) {
  const box = fixture(t);
  box.put('pullboard.json', CONFIG);
  box.put('bin/cells-plan/seed.json', JSON.stringify(SEED));
  for (const file of ['src/board.js', 'src/claims.js', 'src/stats-flow.js']) box.put(file, 'export const unused = 1;\n');
  box.put('src/stats.js', 'export const stats = 1;\n');
  box.put('src/mid.js', "import { leaf } from './stats-leaf.js';\nexport const mid = leaf;\n");
  box.put('src/late.js', 'export const late = 1;\n');
  box.put('src/cli.js', "import { shell } from './stats.js';\nconsole.log(shell);\n");
  box.put('bin/tool.js', "import '../src/cli.js';\n");
  box.put('packages/stats/src/core/pure.js', 'export const pure = 1;\n');
  box.put('packages/stats/src/shell/shell.js', 'export const shell = 2;\nexport const extra = 3;\n');
  box.put('packages/stats/src/shell/leaf.js', 'export const leaf = 4;\n');
  box.put('packages/stats/core.js', 'export * from "./src/core/pure.js";\n');
  box.put('packages/stats/index.js', 'export * from "./core.js";\nexport { shell } from "./src/shell/shell.js";\nexport * from "../../src/late.js";\n');
  box.put('src/stats.js', 'export { pure, shell } from "../packages/stats/index.js";\nexport { extra } from "../packages/stats/src/shell/shell.js";\n');
  box.put('src/stats-leaf.js', 'export { leaf } from "../packages/stats/src/shell/leaf.js";\n');
  box.put('src/uses-shell.js', "import { shell } from './stats.js';\nexport { shell };\n");
  box.put('src/uses-extra.js', "import { extra } from './stats.js';\nexport { extra };\n");
  box.put('src/lazy.js', "export const lazy = () => import('./stats.js');\n");
  box.put('src/reader.js', "import { readFileSync } from 'node:fs';\nexport const text = readFileSync(new URL('./stats.js', import.meta.url), 'utf8');\nimport { resolve } from 'node:path';\nexport const here = resolve(import.meta.dirname, './stats.js');\n");
  box.put('test/pure.test.js', "import { pure } from '../src/stats.js';\nconsole.log(pure);\n");
  box.put('test/declared.test.js', '/** @pullboard-test-input src/stats.js package.json */\nexport const declared = 1;\n');
  const plan = computePlan(box.root);
  const order = ['kernel', 'stats', 'mid', 'late', 'app:cli', 'store', 'items'];
  for (const cell of plan.cells) cell.order = order.indexOf(cell.name) + 1;
  plan.cells.sort((a, b) => a.order - b.order);
  const stats = plan.cells.find(cell => cell.name === 'stats');
  Object.assign(stats, { root: 'packages/stats', frontDoor: 'packages/stats/index.js', pureFrontDoor: 'packages/stats/core.js',
    paths: [['src/stats.js', 'packages/stats/src/shell/shell.js', 'seed'], ['src/stats-leaf.js', 'packages/stats/src/shell/leaf.js', 'seed']],
    reexports: ['src/stats.js', 'src/stats-leaf.js'] });
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'shimmed fixture');
  return { ...box, plan };
}

/** Read one fixture file's current bytes. */
const read = (box, file) => readFixture(box.root, file);

test('removal repoints each importer kind, adds a missing binding, deletes the shim and keeps the upward one [C7,D3]', t => {
  const box = shimmed(t);
  box.put('docs/architecture.md', 'The stats body was src/stats.js; src/stats.json and src/stats.js.map are other files.\n');
  box.put('docs/guide.md', 'See src/stats.js.\n');
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n");
  assert.equal(read(box, 'test/pure.test.js'), "import { pure } from '../packages/stats/core.js';\nconsole.log(pure);\n");
  assert.equal(read(box, 'src/lazy.js'), "export const lazy = () => import('../packages/stats/index.js');\n");
  assert.match(read(box, 'src/reader.js'), /resolve\(import\.meta\.dirname, '\.\.\/packages\/stats\/src\/shell\/shell\.js'\)/u, 'a resolved path names the exact moved file');
  assert.match(read(box, 'src/reader.js'), /new URL\('\.\.\/packages\/stats\/src\/shell\/shell\.js', import\.meta\.url\)/u);
  assert.equal(read(box, 'test/declared.test.js').split('\n')[0], '/** @pullboard-test-input packages/stats/src/shell/shell.js package.json */');
  assert.equal(read(box, 'docs/architecture.md'), 'The stats body was packages/stats/src/shell/shell.js; src/stats.json and src/stats.js.map are other files.\n', 'a core-lane doc cites the moved file');
  assert.equal(read(box, 'docs/guide.md'), 'See src/stats.js.\n', 'a docs-lane citation is left to its lane');
  assert.deepEqual(result.cited, ['docs/guide.md (docs lane) cites src/stats.js; not rewritten outside the core lane']);
  assert.equal(read(box, 'src/uses-extra.js'), "import { extra } from '../packages/stats/index.js';\nexport { extra };\n");
  assert.match(read(box, 'packages/stats/index.js'), /export \{ extra \} from "\.\/src\/shell\/shell\.js";/u);
  assert.equal(existsSync(join(box.root, 'src/stats.js')), false, 'src/stats.js has no importer left');
  assert.deepEqual(result.deleted, ['src/stats.js']);
  assert.equal(existsSync(join(box.root, 'src/stats-leaf.js')), true, 'repointing mid to the stats door would cut upward into late');
  const [shim, reason] = result.kept.find(([name]) => name === 'src/stats-leaf.js');
  assert.equal(shim, 'src/stats-leaf.js');
  assert.match(reason, /src\/mid\.js: removal would expose an upward cut: mid still imports later late: packages\/stats\/index\.js/u);
  assert.equal(read(box, 'src/mid.js'), "import { leaf } from './stats-leaf.js';\nexport const mid = leaf;\n");
  assert.deepEqual(result.plan.cells.find(cell => cell.name === 'stats').reexports, ['src/stats-leaf.js']);
});

test('a core file keeps its shim rather than reach past the cell core [C7,D3]', t => {
  const box = shimmed(t);
  box.put('packages/stats/src/core/impure.js', "import { shell } from '../../../../src/stats.js';\nexport const impure = shell;\n");
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.equal(existsSync(join(box.root, 'src/stats.js')), true);
  assert.equal(read(box, 'packages/stats/src/core/impure.js'), "import { shell } from '../../../../src/stats.js';\nexport const impure = shell;\n");
  assert.match(result.kept.find(([shim]) => shim === 'src/stats.js')[1], /core file packages\/stats\/src\/core\/impure\.js/u);
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n", 'the other importers still move');
});

test('a view-lane importer keeps its shim and its file, and a second run changes nothing [C7,D3]', t => {
  const box = shimmed(t);
  const view = "import { shell } from '../stats.js';\nexport { shell };\n";
  box.put('src/view/panel.js', view);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view importer');
  const run = () => runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats'], { cwd: box.root, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /kept src\/stats\.js: imported by src\/view\/panel\.js \(view lane\)/u);
  assert.doesNotMatch(first.stdout, /deleted src\/stats\.js/u);
  assert.equal(existsSync(join(box.root, 'src/stats.js')), true);
  assert.equal(read(box, 'src/view/panel.js'), view, 'the view file is never rewritten');
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n", 'core importers still move');
  assert.equal(readPlan(box.root).cells.find(cell => cell.name === 'stats').reexports.join(), 'src/stats.js,src/stats-leaf.js');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'first removal');
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(box.root, 'status', '--porcelain').trim(), '', 'the second run leaves the tree untouched');
  assert.match(again.stdout, /0 deleted, 2 kept, 0 repointed/u);
});

/** Commit view-lane importers of the core-owned shim src/stats.js and run a view-lane removal on them. */
function viewRemoval(t, files) {
  const box = shimmed(t);
  for (const [file, source] of Object.entries(files)) box.put(file, source);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view importers');
  const door = read(box, 'packages/stats/index.js'), core = read(box, 'src/uses-shell.js');
  const result = removeShims(box.root, readPlan(box.root), 'stats', { parsers: PARSERS, lane: 'view' });
  assert.equal(read(box, 'src/uses-shell.js'), core, 'core importers are left to the core lane');
  assert.equal(existsSync(join(box.root, 'src/stats.js')), true, 'the core-owned shim stays');
  assert.deepEqual(result.deleted, []);
  return { box, door, result, reason: new Map(result.kept).get('src/stats.js') };
}

test('(a) with lane view, a view importer of a core-owned shim leaves that shim in place and reports it [C7,D3]', t => {
  const { box, reason } = viewRemoval(t, { 'src/view/rail.js': "import { shell } from '../stats.js';\nexport { shell };\n" });
  assert.equal(read(box, 'src/view/rail.js'), "import { shell } from '../../packages/stats/index.js';\nexport { shell };\n", 'the view importer the door serves moves');
  assert.match(reason, /src\/stats\.js is owned by the core lane/u);
  assert.equal(git(box.root, 'status', '--porcelain').trim(), 'M src/view/rail.js', 'only the view file changed');
});

test('(b) with lane view, a view importer needing a binding absent from a core-owned front door adds nothing and reports it [C7,D3]', t => {
  const { box, door, reason } = viewRemoval(t, { 'src/view/panel.js': "import { extra } from '../stats.js';\nexport { extra };\n" });
  assert.equal(read(box, 'src/view/panel.js'), "import { extra } from '../stats.js';\nexport { extra };\n");
  assert.equal(read(box, 'packages/stats/index.js'), door, 'the core-owned front door is never appended to');
  assert.match(reason, /src\/view\/panel\.js needs extra added to packages\/stats\/index\.js \(core lane\)/u);
  assert.match(reason, /imported by src\/\S+ \(core lane\)/u, 'the core importers hold it too, named after the refusal');
  assert.equal(git(box.root, 'status', '--porcelain').trim(), '', 'nothing was written');
});

test('(c) with lane core, a door addition and the shim deletion proceed; a plan shard owned elsewhere holds the deletion [C7,D3]', t => {
  const box = shimmed(t);
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS, lane: 'core', planFiles: ['bin/cells-plan.json', 'bin/cells-plan/02-stats.json'] });
  assert.match(read(box, 'packages/stats/index.js'), /export \{ extra \} from "\.\/src\/shell\/shell\.js";/u, 'core adds to its own door');
  assert.deepEqual(result.deleted, ['src/stats.js'], 'core deletes its own shim');
  const config = JSON.parse(read(box, 'pullboard.json'));
  config.lanes.view.owns.push('bin/cells-plan/02-stats.json');
  const other = shimmed(t);
  other.put('pullboard.json', JSON.stringify(config));
  git(other.root, 'add', '-A');
  git(other.root, 'commit', '-q', '-m', 'view owns the stats shard');
  const shard = read(other, 'bin/cells-plan/02-stats.json'), index = read(other, 'bin/cells-plan.json');
  const run = runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats'], { cwd: other.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /kept src\/stats\.js: deleting src\/stats\.js rewrites bin\/cells-plan\/02-stats\.json \(view lane\), outside the core lane/u);
  assert.equal(existsSync(join(other.root, 'src/stats.js')), true);
  assert.equal(read(other, 'bin/cells-plan/02-stats.json'), shard, 'the view-owned shard is never written');
  assert.equal(read(other, 'bin/cells-plan.json'), index);
});

/** Give the shimmed fixture a runner worker, a shipped-file manifest and one move declaration, then commit. */
function withClosures(box, { core = 'export * from "./src/core/pure.js";\n', extra = {} } = {}) {
  box.put('package.json', JSON.stringify({ type: 'module', files: ['src', 'packages', 'bin'] }));
  box.put('src/runner-worker.js', "import { step } from './worker-step.js';\nexport const worker = step;\n");
  box.put('src/stats-pure.js', 'export { pure } from "../packages/stats/src/core/pure.js";\n');
  box.put('src/moves/seed.js', "import { pure } from '../stats-pure.js';\nexport const seed = pure;\n");
  box.put('packages/stats/core.js', core);
  for (const [file, source] of Object.entries(extra)) box.put(file, source);
  const plan = readPlan(box.root), stats = plan.cells.find(cell => cell.name === 'stats');
  stats.paths.push(['src/stats-pure.js', 'packages/stats/src/core/pure.js', 'seed']);
  stats.reexports.push('src/stats-pure.js');
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'closures');
  return plan;
}


test('a plan file another lane owns that writing the plan would prune holds every deletion, and stays [C7,D3]', t => {
  const box = shimmed(t);
  const config = JSON.parse(read(box, 'pullboard.json'));
  config.lanes.view.owns.push('bin/cells-plan/99-view-retired.json');
  box.put('pullboard.json', JSON.stringify(config));
  box.put('bin/cells-plan/99-view-retired.json', '{"retired": true}\n');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view owns a retired plan file');
  const run = runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats', '--lane', 'core'], { cwd: box.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(read(box, 'bin/cells-plan/99-view-retired.json'), '{"retired": true}\n', 'the view-owned plan file is never pruned');
  assert.match(run.stdout, /kept src\/stats\.js: deleting src\/stats\.js rewrites bin\/cells-plan\/99-view-retired\.json \(view lane\), outside the core lane/u);
  assert.equal(existsSync(join(box.root, 'src/stats.js')), true);
});

test('a runner-closure importer reads core.js while a shell importer of the same shim reads the front door [C7,D3]', t => {
  const box = shimmed(t);
  box.put('src/worker-step.js', "import { pure } from './stats.js';\nexport const step = pure;\n");
  const plan = withClosures(box);
  const result = removeShims(box.root, plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/worker-step.js'), "import { pure } from '../packages/stats/core.js';\nexport const step = pure;\n");
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n");
  assert.equal(read(box, 'src/moves/seed.js'), "import { pure } from '../../packages/stats/core.js';\nexport const seed = pure;\n", 'a move declaration reads core.js');
  assert.ok(result.deleted.includes('src/stats.js') && result.deleted.includes('src/stats-pure.js'));
});

test('a runner-closure importer of a binding core.js lacks keeps its shim and names the binding [C7,D3]', t => {
  const box = shimmed(t);
  const step = "import { shell } from './stats.js';\nexport const step = shell;\n";
  box.put('src/worker-step.js', step);
  const plan = withClosures(box);
  const result = removeShims(box.root, plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/worker-step.js'), step);
  assert.match(new Map(result.kept).get('src/stats.js'), /runner-worker closure file src\/worker-step\.js would reach past stats core\.js, which lacks shell/u);
});

/** A fixture whose core.js also re-exports one module that a closure cannot take. */
function brokenCore(t, file, source) {
  const box = shimmed(t);
  box.put('src/worker-step.js', "import { pure } from './stats-pure.js';\nexport const step = pure;\n");
  const plan = withClosures(box, { core: `export * from "./src/core/pure.js";\nexport * from "./src/core/${file}";\n`, extra: { [`packages/stats/src/core/${file}`]: source } });
  return { box, result: removeShims(box.root, plan, 'stats', { parsers: PARSERS }) };
}

test('a repoint that would push the runner closure past its 1 MiB bound keeps that importer on its shim [C7,D3]', t => {
  const { box, result } = brokenCore(t, 'big.js', `export const big = ${JSON.stringify('x'.repeat(1_100_000))};\n`);
  assert.equal(read(box, 'src/worker-step.js'), "import { pure } from './stats-pure.js';\nexport const step = pure;\n");
  assert.match(new Map(result.kept).get('src/stats-pure.js'), /repointing src\/\S+ would break the runner-worker closure: .*1 MiB/u);
  assert.equal(existsSync(join(box.root, 'src/stats-pure.js')), true);
});

test('a repoint that would pull a process launcher into the move-registry closure keeps that importer on its shim [C7,D3]', t => {
  const { box, result } = brokenCore(t, 'spawn.js', "import { spawn } from 'node:child_process';\nexport const launch = spawn;\n");
  assert.equal(read(box, 'src/moves/seed.js'), "import { pure } from '../stats-pure.js';\nexport const seed = pure;\n");
  assert.match(new Map(result.kept).get('src/stats-pure.js'), /would break the move-registry closure: process launcher packages\/stats\/src\/core\/spawn\.js/u);
  assert.equal(existsSync(join(box.root, 'src/stats-pure.js')), true);
});
