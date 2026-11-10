/** @pullboard-test-input source-tree */
/** One command removes a cell's shims: repoint, delete, keep what would cut upward, and change nothing the second time [C7,D3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { removeShims } from '../../../../packages/codemap/src/io/cells/shims.js';
import { scriptMentions } from '../../../../packages/codemap/src/io/cells/shims.js';
import { writeShimHandoff } from '../../../../packages/codemap/src/io/cells/shims.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { CONFIG } from '../../tests/fixtures/cells/shims.js';
import { readFixture } from '../../tests/fixtures/cells/shims.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { inventoryBuildCount } from '../../../../packages/codemap/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const PARSERS = { importsIn, commonJsIn };
const TOOL = fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const SEED = { source: 'fixture', sha256: 'none', order: ['kernel', 'stats', 'mid', 'late', 'app:cli'],
  cells: { kernel: ['src/refused.js'], stats: ['src/stats.js'], mid: ['src/mid.js'], late: ['src/late.js'], 'app:cli': ['src/cli.js'] }, tests: {} };

/** A stats cell already moved behind shims, with one importer of every kind and one that would cut upward. */
function shimmed(t) {
  const box = fixture(t);
  const config = JSON.parse(CONFIG);
  config.lanes.core.owns.push('src/', 'bin/', 'test/');
  config.lanes.view.owns.push('src/view/');
  box.put('pullboard.json', JSON.stringify(config));
  box.put('packages/codemap/data/plan/seed.json', JSON.stringify(SEED));
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

test('an importer of a name the door binds to a different definition keeps the shim, named and namespace alike [C7,D3]', t => {
  const box = shimmed(t);
  box.put('packages/stats/src/shell/write.js', 'export const open = "write";\n');
  box.put('packages/stats/src/shell/read.js', 'export const open = "read";\n');
  box.put('packages/stats/index.js', read(box, 'packages/stats/index.js') + 'export { open } from "./src/shell/read.js";\nexport { open as write_open } from "./src/shell/write.js";\n');
  box.put('src/stats-open.js', 'export { write_open as open } from "../packages/stats/index.js";\n');
  box.put('src/uses-open.js', "import { open } from './stats-open.js';\nexport { open };\n");
  box.put('src/all-open.js', "import * as all from './stats-open.js';\nexport const keys = Object.keys(all);\n");
  const plan = readPlan(box.root), stats = plan.cells.find(cell => cell.name === 'stats');
  stats.paths.push(['src/stats-open.js', 'packages/stats/src/shell/write.js', 'seed']);
  stats.reexports.push('src/stats-open.js');
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'aliased door');
  const result = removeShims(box.root, plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/uses-open.js'), "import { open } from './stats-open.js';\nexport { open };\n", 'the read-store open is never swapped in');
  assert.equal(read(box, 'src/all-open.js'), "import * as all from './stats-open.js';\nexport const keys = Object.keys(all);\n");
  const reason = new Map(result.kept).get('src/stats-open.js');
  assert.match(reason, /src\/uses-open\.js imports open from src\/stats-open\.js, which packages\/stats\/index\.js binds to a different definition/u);
  assert.match(reason, /src\/all-open\.js imports open from src\/stats-open\.js/u);
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

test('a namespace importer keeps its shim when the door exports more names than the shim, named or dynamic [C7,D3]', t => {
  const box = shimmed(t);
  box.put('src/all.js', "import * as all from './stats.js';\nexport const keys = Object.keys(all);\n");
  box.put('src/lazy.js', "export const lazy = () => import('./stats.js');\n");
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/all.js'), "import * as all from './stats.js';\nexport const keys = Object.keys(all);\n", 'Object.keys of the namespace never gains late');
  assert.equal(read(box, 'src/lazy.js'), "export const lazy = () => import('./stats.js');\n");
  const reason = new Map(result.kept).get('src/stats.js');
  assert.match(reason, /src\/all\.js takes the whole src\/stats\.js namespace, and packages\/stats\/index\.js also exports late/u);
  assert.match(reason, /src\/lazy\.js takes the whole src\/stats\.js namespace/u);
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n", 'a named importer still moves');
});

test('a run that adds a name to the door for one importer leaves a namespace importer of another shim on its shim [C7,D3]', t => {
  // The reviewer composition case (refs/pullboard/review-evidence/item-2221-composition-core-898).
  const box = shimmed(t);
  box.put('packages/stats/index.js', 'export * from "./core.js";\nexport { shell, extra } from "./src/shell/shell.js";\n');
  box.put('src/all-stats.js', "import * as all from './stats.js';\nexport const names = Object.keys(all);\n");
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.match(read(box, 'packages/stats/index.js'), /export \{ leaf \}/u, 'the run adds leaf to the door for the leaf importer');
  assert.equal(read(box, 'src/all-stats.js'), "import * as all from './stats.js';\nexport const names = Object.keys(all);\n", 'the namespace never widens to leaf');
  assert.match(new Map(result.kept).get('src/stats.js'), /src\/all-stats\.js takes a whole namespace, and this run adds leaf to packages\/stats\/index\.js/u);
});

test('a module URL handed to a child as .href keeps import semantics, while a byte read names the moved file [C7,D3]', t => {
  const box = shimmed(t);
  box.put('test/module.test.js', "import { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\nexport const url = pathToFileURL(resolve(import.meta.dirname, '../src/stats.js')).href;\n");
  box.put('test/child.test.js', "const source = `import { shell } from ${JSON.stringify(new URL('../src/stats.js', import.meta.url).href)};`;\nexport { source };\n");
  // A door with exactly the shim's names, so a whole-namespace child import may move to it.
  box.put('src/mid.js', 'export const mid = 1;\n'); // no leaf importer, so this run adds nothing to the door
  box.put('packages/stats/index.js', 'export * from "./core.js";\nexport { shell, extra } from "./src/shell/shell.js";\n');
  removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.match(read(box, 'test/module.test.js'), /resolve\(import\.meta\.dirname, '\.\.\/packages\/stats\/index\.js'\)/u, 'a module URL built from a path goes to the front door');
  assert.match(read(box, 'test/child.test.js'), /new URL\('\.\.\/packages\/stats\/index\.js', import\.meta\.url\)\.href/u, 'a child import goes to the front door');
  assert.match(read(box, 'src/reader.js'), /new URL\('\.\.\/packages\/stats\/src\/shell\/shell\.js', import\.meta\.url\)/u, 'a byte read still names the moved file');
});

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
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS, lane: 'core', planFiles: ['packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/02-stats.json'] });
  assert.match(read(box, 'packages/stats/index.js'), /export \{ extra \} from "\.\/src\/shell\/shell\.js";/u, 'core adds to its own door');
  assert.deepEqual(result.deleted, ['src/stats.js'], 'core deletes its own shim');
  const config = JSON.parse(read(box, 'pullboard.json'));
  config.lanes.view.owns.push('packages/codemap/data/plan/02-stats.json');
  const other = shimmed(t);
  other.put('pullboard.json', JSON.stringify(config));
  git(other.root, 'add', '-A');
  git(other.root, 'commit', '-q', '-m', 'view owns the stats shard');
  const shard = read(other, 'packages/codemap/data/plan/02-stats.json'), index = read(other, 'packages/codemap/data/plan/cells.json');
  const run = runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats'], { cwd: other.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /kept src\/stats\.js: deleting src\/stats\.js rewrites packages\/codemap\/data\/plan\/02-stats\.json \(view lane\), outside the core lane/u);
  assert.equal(existsSync(join(other.root, 'src/stats.js')), true);
  assert.equal(read(other, 'packages/codemap/data/plan/02-stats.json'), shard, 'the view-owned shard is never written');
  assert.equal(read(other, 'packages/codemap/data/plan/cells.json'), index);
});

/** Give the shimmed fixture a runner worker, a shipped-file manifest and one move declaration, then commit. */
function withClosures(box, { core = 'export * from "./src/core/pure.js";\n', extra = {} } = {}) {
  box.put('package.json', JSON.stringify({ type: 'module', files: ['src', 'packages', 'bin', 'apps'] }));
  box.put('apps/runner/src/io/scripts/worker.js', "import { step } from '../../../../../src/worker-step.js';\nexport const worker = step;\n");
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
  config.lanes.view.owns.push('packages/codemap/data/plan/99-view-retired.json');
  box.put('pullboard.json', JSON.stringify(config));
  box.put('packages/codemap/data/plan/99-view-retired.json', '{"retired": true}\n');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view owns a retired plan file');
  const run = runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats', '--lane', 'core'], { cwd: box.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(read(box, 'packages/codemap/data/plan/99-view-retired.json'), '{"retired": true}\n', 'the view-owned plan file is never pruned');
  assert.match(run.stdout, /kept src\/stats\.js: deleting src\/stats\.js rewrites packages\/codemap\/data\/plan\/99-view-retired\.json \(view lane\), outside the core lane/u);
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

test('a core importer reads its pure door while a shell importer of the same shim reads index.js [C7,D3]', t => {
  const box = shimmed(t);
  box.put('src/worker-step.js', "import { pure } from './stats.js';\nexport const step = pure;\n");
  box.put('packages/stats/src/core/uses.js', "import { pure } from '../../../../src/stats.js';\nexport const used = pure;\n");
  const plan = withClosures(box);
  removeShims(box.root, plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'packages/stats/src/core/uses.js'), "import { pure } from '../../core.js';\nexport const used = pure;\n");
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n");
});

test('a pure binding with another definition keeps the runner importer and names that binding [C7,D3]', t => {
  const box = shimmed(t);
  const step = "import { pure } from './stats.js';\nexport const step = pure;\n";
  box.put('src/worker-step.js', step);
  const plan = withClosures(box, {
    core: 'export { pure } from "./src/core/rebound.js";\n',
    extra: {
      'packages/stats/src/core/rebound.js': 'export const pure = 2;\n',
      'src/stats.js': 'export { pure } from "../packages/stats/src/core/pure.js";\nexport { shell, extra } from "../packages/stats/src/shell/shell.js";\n',
    },
  });
  const result = removeShims(box.root, plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/worker-step.js'), step, 'a same-name export cannot replace the original definition');
  assert.equal(existsSync(join(box.root, 'src/stats.js')), true, 'the still-used shim stays present');
  assert.match(new Map(result.kept).get('src/stats.js'), /runner-worker closure file src\/worker-step\.js would reach past stats core\.js, which lacks pure/u);
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

test('quoted prose and unrelated join or URL calls do not name a deleted module [C7,D3]', () => {
  const source = [
    `const prose = "See './src/stats.js' for background";`,
    `const proseColon = "See: './src/stats.js'";`,
    `const joined = list.join('src/stats.js');`,
    `const url = URL('src/stats.js');`,
    `const foreign = runtime.require('src/stats.js');`,
    `const foreignPath = other.path.join(root, 'src/stats.js');`,
    `const actual = path.join(root, 'src/stats.js');`,
    `const urlPath = 'file:src/stats.js';`,
    `const generated = \"import './src/stats.js';\";`,
    `const assigned = \"const target = './src/stats.js';\";`,
  ].join('\n');
  assert.deepEqual(scriptMentions(new Map([['test/mentions.test.js', Buffer.from(source)]]), ['src/stats.js']),
    [7, 8, 9, 10].map(line => ({ file: 'test/mentions.test.js', line, path: 'src/stats.js' })));
});

test('comments inside generated scripts do not name a deleted module [C7,D3]', () => {
  const source = "const script = `// require('./src/stats.js')\nconst value = 1;`;\n";
  assert.deepEqual(scriptMentions(new Map([['test/comment-script.test.js', Buffer.from(source)]]), ['src/stats.js']), []);
});

test('comments inside generated modules do not name a deleted module [C7,D3]', () => {
  const source = "const script = `// require('./src/stats.js')\nexport const value = 1;`;\n";
  assert.deepEqual(scriptMentions(new Map([['test/comment-module.test.js', Buffer.from(source)]]), ['src/stats.js']), []);
});

test('a multiline generated script reports the line containing the module path [C7,D3]', () => {
  const source = "const script = `\nimport './src/stats.js';\n`;\n";
  assert.deepEqual(scriptMentions(new Map([['test/multiline.test.js', Buffer.from(source)]]), ['src/stats.js']),
    [{ file: 'test/multiline.test.js', line: 2, path: 'src/stats.js' }]);
});

test('a shim a test names inside a generated script stays, and a comment or prose mention never holds it [C7,D3]', t => {
  const quiet = shimmed(t);
  quiet.put('test/comment.test.js', '// src/stats.js once held the stats shell\nexport const note = 1;\n');
  quiet.put('test/prose.test.js', 'export const description = "The retired src/stats.js was a shim, not an import";\n');
  assert.deepEqual(removeShims(quiet.root, quiet.plan, 'stats', { parsers: PARSERS }).deleted, ['src/stats.js'], 'a comment or prose sentence is not a use');
  const prose = shimmed(t);
  prose.put('test/prose.test.js', "export const note = 'the old src/stats.js held the stats shell';\n");
  assert.deepEqual(removeShims(prose.root, prose.plan, 'stats', { parsers: PARSERS }).deleted, ['src/stats.js'], 'a prose sentence naming the path is not a use');
  const forms = [root => './src/stats.js', root => join(root, 'src/stats.js'), root => pathToFileURL(join(root, 'src/stats.js')).href];
  for (const form of forms) {
    for (const wrap of [spec => spec, spec => `import('${spec}').then(m => console.log(m.shell));`]) {
      const box = shimmed(t);
      box.put('test/child.test.js', `export const script = ${JSON.stringify(wrap(form(box.root)))};\n`);
      const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
      assert.equal(existsSync(join(box.root, 'src/stats.js')), true, `the test still names ${form(box.root)}`);
      assert.deepEqual(result.deleted, []);
      assert.match(result.kept.find(([shim]) => shim === 'src/stats.js')[1], /test\/child\.test\.js:1 names src\/stats\.js inside a string/u);
    }
  }
});

test('one removal builds exactly one inventory, however many repoint passes it takes [C7,D3]', t => {
  const box = shimmed(t);
  const before = inventoryBuildCount();
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.ok(result.rewritten.length > 0, 'the fixture repoints importers, so the loop ran at least once');
  assert.equal(inventoryBuildCount() - before, 1, 'the sweep reuses one inventory and updates only the files it edited');
});

/** Count the git commands git itself traced into a file while `work` ran. */
function gitCalls(t, work) {
  const trace = join(mkdtempSync(join(tmpdir(), 'pullboard-shim-trace-')), 'trace.log');
  const had = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try { work(); } finally { if (had === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = had; }
  let traced = '';
  try { traced = readFileSync(trace, 'utf8'); } catch { /* git never ran */ }
  t.after(() => rmSync(dirname(trace), { recursive: true, force: true }));
  return traced.split('\n').filter(line => /trace: (built-in|run_command): git /u.test(line)).length;
}

test('removal on a largest-cell-shaped fixture builds one inventory and spawns git a bounded number of times, not once per importer [C7,D3]', t => {
  const box = shimmed(t);
  const importers = 120;
  for (let i = 0; i < importers; i++) box.put(`src/many-${i}.js`, `import { shell } from './stats.js';\nexport const v${i} = shell;\n`);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'many importers');
  const before = inventoryBuildCount();
  let result;
  const calls = gitCalls(t, () => { result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS }); });
  assert.ok(result.rewritten.length >= importers, 'every generated importer was repointed');
  assert.equal(inventoryBuildCount() - before, 1, 'one inventory for the whole run');
  // Time is proved by bounded work, not a clock (wall-clock policy). The run reads the repository in batches, so
  // git spawns stay far below the importer count; one per importer would have been 120 or more.
  assert.ok(calls <= 20, `git ran ${calls} times for ${importers} importers`);
  console.log(`# remove-shims importers ${importers} gitcalls ${calls}`);
});

test('kept shims write complete fact and cut drafts; an empty run writes nothing [C7,D3]', t => {
  const box = shimmed(t);
  for (let index = 0; index < 5; index++) box.put(`packages/mid/src/use-${index}.js`, "import { leaf } from '../../../src/stats-leaf.js'; export { leaf };\n");
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  const out = join(box.root, 'handoff');
  const handoff = writeShimHandoff(box.root, result, 'stats', { directory: out, env: { ...process.env, PATH: '' } });
  assert.ok(handoff);
  const fact = readFileSync(join(out, 'fact.txt'), 'utf8');
  const draft = readFileSync(join(out, 'cut-item.txt'), 'utf8');
  for (let index = 0; index < 5; index++) {
    assert.match(fact, new RegExp(`packages/mid/src/use-${index}\\.js`, 'u'));
    assert.match(draft, new RegExp(`packages/mid/src/use-${index}\\.js`, 'u'));
  }
  assert.match(draft, /--after <removal item id>/u);
  const empty = join(box.root, 'empty-handoff');
  assert.equal(writeShimHandoff(box.root, { keptDetails: [] }, 'stats', { directory: empty }), null);
  assert.equal(existsSync(empty), false);
});

test('remove-shims CLI prints and writes its kept-shim handoff [C7,D3]', t => {
  const box = shimmed(t);
  box.put('src/view/panel.js', "import { shell } from '../stats.js'; export { shell };\n");
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view importer');
  const out = mkdtempSync(join(tmpdir(), 'shim-handoff-test-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const run = runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats', '--output-dir', out], { cwd: box.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /src\/view\/panel\.js/u);
  assert.match(run.stdout, /pullboard [\s\S]*--after/u);
  assert.match(readFileSync(join(out, 'fact.txt'), 'utf8'), /src\/view\/panel\.js/u);
  assert.match(readFileSync(join(out, 'cut-item.txt'), 'utf8'), /--after/u);
});

test('file-cut records the kept fact and shouts its cut draft on a real fixture board [C7,D3]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Remove private shims', '--criterion', 'Remove the shims.', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const result = { keptDetails: [{ shim: 'src/example.js', reason: 'upward cut', importers: ['packages/one.js', 'packages/two.js'] }] };
  const handoff = writeShimHandoff(box.web, result, 'example', { lane: 'web', directory: join(box.dir, 'handoff'), fileCut: true, env: box.env });
  assert.equal(handoff.after, id);
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /packages\/one\.js/u);
  const inbox = box.run(box.repo, 'inbox', '--json');
  assert.equal(inbox.code, 0, inbox.err);
  assert.match(inbox.out, /Cells cut: remove remaining example shim importers/u);
  assert.match(inbox.out, /packages\/two\.js/u);
  assert.match(inbox.out, new RegExp(`after #${id}`, 'u'));
});
