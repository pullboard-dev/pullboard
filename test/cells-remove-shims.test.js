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
  const result = removeShims(box.root, box.plan, 'stats', { parsers: PARSERS });
  assert.equal(read(box, 'src/uses-shell.js'), "import { shell } from '../packages/stats/index.js';\nexport { shell };\n");
  assert.equal(read(box, 'test/pure.test.js'), "import { pure } from '../packages/stats/core.js';\nconsole.log(pure);\n");
  assert.equal(read(box, 'src/lazy.js'), "export const lazy = () => import('../packages/stats/index.js');\n");
  assert.match(read(box, 'src/reader.js'), /resolve\(import\.meta\.dirname, '\.\.\/packages\/stats\/index\.js'\)/u);
  assert.match(read(box, 'src/reader.js'), /new URL\('\.\.\/packages\/stats\/src\/shell\/shell\.js', import\.meta\.url\)/u);
  assert.equal(read(box, 'test/declared.test.js').split('\n')[0], '/** @pullboard-test-input packages/stats/src/shell/shell.js package.json */');
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

test('a second run changes nothing, and the command prints the importers outside its lane [C7,D3]', t => {
  const box = shimmed(t);
  box.put('src/view/panel.js', "import { shell } from '../stats.js';\nexport { shell };\n");
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'view importer');
  const run = () => runFixtureChild(process.execPath, [TOOL, '--remove-shims', 'stats'], { cwd: box.root, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /deleted src\/stats\.js/u);
  assert.match(first.stdout, /kept src\/stats-leaf\.js: src\/mid\.js: removal would expose an upward cut/u);
  assert.match(first.stdout, /outside the core lane, attach: src\/view\/panel\.js/u);
  assert.equal(readPlan(box.root).cells.find(cell => cell.name === 'stats').reexports.join(), 'src/stats-leaf.js');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'first removal');
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(box.root, 'status', '--porcelain').trim(), '', 'the second run leaves the tree untouched');
  assert.match(again.stdout, /0 deleted, 1 kept, 0 repointed/u);
});
