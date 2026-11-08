/** Deterministic test placement follows real input edges without hiding uncertainty [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTestFiles } from '../bin/cells-test-placement.js';
import { placeTests } from '../bin/cells-test-placement.js';
import { runFixtureChild } from './fixture-child.js';
import { fileURLToPath } from 'node:url';

const plan = { cells: [
  { name: 'kernel', root: 'packages/kernel', paths: [['src/a.js', 'packages/kernel/a.js']] },
  { name: 'store', root: 'packages/store', paths: [['src/b.js', 'packages/store/b.js']] },
] };
const files = new Map(['test/one.test.js', 'test/helper.js', 'test/journey.test.js', 'test/missing.test.js',
  'test/asset.txt', 'docs/guide.test.js', 'src/a.js', 'src/b.js'].map(file => [file, Buffer.from('')]));
const edges = new Map([
  ['test/one.test.js', [{ target: 'test/helper.js' }]], ['test/helper.js', [{ target: 'src/a.js' }]],
  ['test/journey.test.js', [{ target: 'src/b.js' }, { target: 'src/a.js' }]],
  ['docs/guide.test.js', [{ target: 'src/b.js' }]], ['test/missing.test.js', []],
]);
const inventory = { files, edges, unknown: [{ file: 'test/missing.test.js', reason: 'computed import' }] };

test('every tracked test and docs check is classified deterministically [C7,CD64]', () => {
  const tracked = [...files.keys()].reverse();
  const rows = classifyTestFiles(tracked, inventory, plan);
  assert.deepEqual(rows, classifyTestFiles([...tracked].reverse(), inventory, plan));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.find(row => row.file === 'test/one.test.js'), { file: 'test/one.test.js', kind: 'cell', cell: 'kernel' });
  assert.deepEqual(rows.find(row => row.file === 'test/journey.test.js'), { file: 'test/journey.test.js', kind: 'journey', cells: ['kernel', 'store'] });
  assert.deepEqual(rows.find(row => row.file === 'test/missing.test.js'), { file: 'test/missing.test.js', kind: 'undecidable', reason: 'computed import', cells: [] });
  assert.equal(rows.find(row => row.file === 'test/asset.txt').kind, 'undecidable');
  assert.equal(rows.find(row => row.file === 'docs/guide.test.js').cell, 'store');
});

test('the repository census accounts for every tracked test and docs check [C7,CD64]', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { readPlan } = await import('../bin/cells-plan.js');
  const { cellInventory } = await import('../packages/codemap/index.js');
  const { importsIn, commonJsIn } = await import('../packages/gate/index.js');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const inventory = cellInventory(root, { importsIn, commonJsIn });
  const rows = classifyTestFiles(tracked, inventory, readPlan(root));
  const expected = tracked.filter(file => file.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(file));
  assert.equal(rows.length, expected.length);
  assert.deepEqual(rows.map(row => row.file), [...expected].sort());
  assert.ok(rows.every(row => row.kind === 'cell' ? !!row.cell : row.kind === 'journey' ? row.cells.length > 1 : !!row.reason));
});

test('clause 3: the fixture report shows a cell, a journey and an unknown reason, with per-cell counts [C7,CD64]', () => {
  const lines = placeTests([...files.keys()], inventory, plan);
  assert.deepEqual(lines, [
    'docs/guide.test.js\tcell store',
    'test/asset.txt\tunknown not a JavaScript module',
    'test/helper.js\tcell kernel',
    'test/journey.test.js\tjourney kernel,store',
    'test/missing.test.js\tunknown computed import',
    'test/one.test.js\tcell kernel',
    'files for cell kernel: 2',
    'files for cell store: 1',
    'journeys: 1',
    'unknown: 2',
    'total: 6',
  ]);
});

test('clause 1: node bin/cells-plan.js --place-tests prints every tracked test file and docs check with its home; clause 2: a repeated run prints identical output [C7,CD64]', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = () => runFixtureChild(process.execPath, ['bin/cells-plan.js', '--place-tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const first = run();
  assert.equal(first.failure, null, first.context);
  const second = run();
  assert.equal(second.failure, null, second.context);
  assert.equal(second.stdout, first.stdout, 'a repeated --place-tests run prints identical output');
  const tracked = runFixtureChild('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\0').filter(Boolean);
  const expected = tracked.filter(path => path.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(path)).sort();
  const lines = first.stdout.trimEnd().split('\n');
  const rows = lines.filter(line => line.includes('\t'));
  assert.deepEqual(rows.map(line => line.split('\t')[0]), expected);
  assert.ok(rows.every(line => /\t(cell \S+|journey \S+,\S+|unknown .+)$/u.test(line)), 'every file names a cell, a journey or an unknown reason');
  const counts = lines.filter(line => line.startsWith('files for cell '));
  const { readPlan } = await import('../bin/cells-plan.js');
  assert.equal(counts.length, readPlan(root).cells.length, 'every plan cell reports how many test files it gets');
  assert.equal(lines.at(-1), `total: ${expected.length}`);
});

/** Build a real Git fixture with a kernel, a store and an app cell, their tests, and optionally a test that reads its own location. */
async function moverFixture(t, { located = false } = {}) {
  const { fixture, git } = await import('./cells-plan-fixture.js');
  const { root, put } = fixture(t);
  const cells = [['kernel', 'package', 'packages/kernel'], ['store', 'package', 'packages/store'], ['app:cli', 'app', 'apps/cli']];
  put('bin/cells-plan.json', JSON.stringify({ version: 1, cells: cells.map(([name], index) => ({ order: index + 1, name, file: `bin/cells-plan/0${index + 1}.json` })), stays: [] }));
  cells.forEach(([name, kind, home], index) => put(`bin/cells-plan/0${index + 1}.json`, JSON.stringify({ order: index + 1, name, kind, root: home,
    frontDoor: `${home}/index.js`, paths: [], cuts: [], reexports: [] })));
  put('packages/kernel/a.js', 'export const a = 1;\n');
  put('packages/store/b.js', 'export const b = 2;\n');
  put('apps/cli/run.js', "export const run = () => 'cli';\n");
  put('test/helper.js', "import { a } from '../packages/kernel/a.js';\nexport const helper = () => a;\n");
  put('test/one.test.js', moverSources.one);
  put('test/journey.test.js', moverSources.journey);
  put('test/cli.test.js', "import assert from 'node:assert/strict';\nimport { run } from '../apps/cli/run.js';\nassert.equal(run(), 'cli');\n");
  if (located) put('test/located.test.js', "import { a } from '../packages/kernel/a.js';\nexport const where = [a, import.meta.dirname];\n");
  git(root, 'add', '-A');
  /** Run the real cells-plan CLI in the fixture. */
  const cli = (...args) => runFixtureChild(process.execPath, [moverCli(), ...args], { cwd: root, encoding: 'utf8' });
  /** The fixture's index and working tree state, for no-change proofs. */
  const state = () => git(root, 'status', '--porcelain', '--untracked-files=all') + '\n' + git(root, 'ls-files', '-s');
  return { root, git, cli, state };
}

/** The real cells-plan CLI path. */
function moverCli() {
  return fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
}

const moverSources = {
  one: "import assert from 'node:assert/strict';\nimport { helper } from './helper.js';\nimport { a } from \"../packages/kernel/a.js\";\nconst label = '../packages/kernel/a.js stays in the body';\nassert.equal(helper(), a);\nassert.ok(label);\n",
  journey: "import assert from 'node:assert/strict';\nimport { helper } from './helper.js';\nimport { b } from '../packages/store/b.js';\nassert.equal(helper() + b, 3);\n",
};

test('clause 1: --move-tests git-mvs a cell\'s tests into packages/<cell>/tests/ and apps/<name>/tests/, repointing import paths only [C7,CD64]', async t => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root, git, cli } = await moverFixture(t);
  const kernel = cli('--move-tests', 'kernel');
  assert.equal(kernel.failure, null, kernel.context);
  assert.deepEqual(kernel.stdout.trimEnd().split('\n'), [
    'moved test/helper.js -> packages/kernel/tests/helper.js',
    'moved test/one.test.js -> packages/kernel/tests/one.test.js',
    'repointed packages/kernel/tests/helper.js: ../packages/kernel/a.js -> ../a.js',
    'repointed packages/kernel/tests/one.test.js: ../packages/kernel/a.js -> ../a.js',
    'repointed test/journey.test.js: ./helper.js -> ../packages/kernel/tests/helper.js',
  ]);
  const app = cli('--move-tests', 'app:cli');
  assert.equal(app.failure, null, app.context);
  assert.match(app.stdout, /^moved test\/cli\.test\.js -> apps\/cli\/tests\/cli\.test\.js$/mu);
  const tracked = git(root, 'ls-files').split('\n');
  for (const file of ['test/cli.test.js', 'test/helper.js', 'test/one.test.js']) assert.ok(!tracked.includes(file), `${file} left the index`);
  for (const file of ['apps/cli/tests/cli.test.js', 'packages/kernel/tests/helper.js', 'packages/kernel/tests/one.test.js']) assert.ok(tracked.includes(file), `${file} is staged at its home`);
  assert.equal(git(root, 'diff', '--name-only'), '', 'every moved file and repointed importer is staged');
  /** Read one fixture file as text. */
  const read = file => readFileSync(join(root, file), 'utf8');
  assert.equal(read('packages/kernel/tests/one.test.js'), moverSources.one.replace('"../packages/kernel/a.js"', '"../a.js"'), 'only the import specifier changed; the body string kept its path');
  assert.equal(read('packages/kernel/tests/helper.js'), "import { a } from '../a.js';\nexport const helper = () => a;\n");
  assert.equal(read('test/journey.test.js'), moverSources.journey.replace("'./helper.js'", "'../packages/kernel/tests/helper.js'"));
  assert.equal(read('apps/cli/tests/cli.test.js'), "import assert from 'node:assert/strict';\nimport { run } from '../run.js';\nassert.equal(run(), 'cli');\n");
  for (const file of ['packages/kernel/tests/one.test.js', 'test/journey.test.js', 'apps/cli/tests/cli.test.js']) {
    const ran = runFixtureChild(process.execPath, [file], { cwd: root, encoding: 'utf8' });
    assert.equal(ran.failure, null, `${file} still runs after the move\n${ran.context}`);
  }
});

test('clause 2: --move-tests refuses an unsafe or unknown path and names it, moving nothing [C7,CD64]', async t => {
  const { cli, state } = await moverFixture(t, { located: true });
  const before = state();
  const cases = [
    [['nosuch'], /CELLS_TESTS_UNKNOWN.*"nosuch"/u],
    [['kernel', '../outside.test.js'], /CELLS_TESTS_UNSAFE.*unsafe path "\.\.\/outside\.test\.js"/u],
    [['kernel', 'test/journey.test.js'], /CELLS_TESTS_UNSAFE.*unknown path test\/journey\.test\.js \(journey kernel,store, not cell kernel\)/u],
    [['kernel', 'test/nothing.test.js'], /unknown path test\/nothing\.test\.js \(not a tracked test file or docs check\)/u],
    [['kernel', 'test/located.test.js'], /unsafe path test\/located\.test\.js \(reads paths relative to its own location/u],
    [['kernel'], /unsafe path test\/located\.test\.js \(reads paths relative to its own location.*nothing moved/u],
  ];
  for (const [args, named] of cases) {
    const refused = cli('--move-tests', ...args);
    assert.equal(refused.status, 1, `--move-tests ${args.join(' ')} refuses\n${refused.context}`);
    assert.match(refused.stderr, named);
    assert.equal(state(), before, `--move-tests ${args.join(' ')} moved or edited nothing`);
  }
});

test('clause 3: a second --move-tests run is a no-op [C7,CD64]', async t => {
  const { cli, state } = await moverFixture(t);
  const first = cli('--move-tests', 'kernel');
  assert.equal(first.failure, null, first.context);
  const moved = state();
  const again = cli('--move-tests', 'kernel');
  assert.equal(again.failure, null, again.context);
  assert.equal(again.stdout, 'nothing to move for kernel\n');
  assert.equal(state(), moved, 'the rerun changed nothing');
  const named = cli('--move-tests', 'kernel', 'test/one.test.js', 'test/helper.js');
  assert.equal(named.failure, null, named.context);
  assert.equal(named.stdout, 'already home: test/helper.js\nalready home: test/one.test.js\nnothing to move for kernel\n');
  assert.equal(state(), moved, 'naming the moved paths again changed nothing');
});
