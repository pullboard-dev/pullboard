/** @pullboard-test-input source-tree */
/** Deterministic test placement follows real input edges without hiding uncertainty [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTestFiles } from '../../../../packages/codemap/src/io/cells/placement.js';
import { placeTests } from '../../../../packages/codemap/src/io/cells/placement.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { join as joinPath } from 'node:path';

/** Run one moved fixture test in this process by importing it: its imports must resolve and its asserts must hold. */
async function runMoved(root, file) {
  try { await import(pathToFileURL(joinPath(root, file)).href); } catch (error) { return { failure: error, context: String(error?.stack ?? error) }; }
  return { failure: null, context: '' };
}

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
  const { readPlan } = await import('../../../../packages/codemap/src/io/cells/scripts/plan.js');
  const { cellInventory } = await import('../../../../packages/codemap/index.js');
  const { importsIn, commonJsIn } = await import('../../../../packages/gate/index.js');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
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

test('clause 1: node packages/codemap/src/io/cells/scripts/plan.js --place-tests prints every tracked test file and docs check with its home; clause 2: a repeated run prints identical output [C7,CD64]', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  // Process-level: the plan script is a standalone entry (argv guard, stdout, exit code), so it stays a child process.
  const run = () => runFixtureChild(process.execPath, ['packages/codemap/src/io/cells/scripts/plan.js', '--place-tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const { readPlan } = await import('../../../../packages/codemap/src/io/cells/scripts/plan.js');
  assert.equal(counts.length, readPlan(root).cells.length, 'every plan cell reports how many test files it gets');
  assert.equal(lines.at(-1), `total: ${expected.length}`);
});

/** Build a real Git fixture with a kernel, a store and an app cell, their tests, and optionally a test that reads its own location. */
async function moverFixture(t, { located = false } = {}) {
  const { fixture, git } = await import('../../../../packages/landing/tests/fixtures/plan.js');
  const { root, put } = fixture(t);
  const cells = [['kernel', 'package', 'packages/kernel'], ['store', 'package', 'packages/store'], ['app:cli', 'app', 'apps/cli']];
  put('packages/codemap/data/plan/cells.json', JSON.stringify({ version: 1, cells: cells.map(([name], index) => ({ order: index + 1, name, file: `bin/cells-plan/0${index + 1}.json` })), stays: [] }));
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
  // Process-level: the real cells-plan script entry, run as its own process.
  const cli = (...args) => runFixtureChild(process.execPath, [moverCli(), ...args], { cwd: root, encoding: 'utf8' });
  /** The fixture's index and working tree state, for no-change proofs. */
  const state = () => git(root, 'status', '--porcelain', '--untracked-files=all') + '\n' + git(root, 'ls-files', '-s');
  return { root, git, cli, state };
}

/** The real cells-plan CLI path. */
function moverCli() {
  return fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
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
    const ran = await runMoved(root, file);
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

test('clause 1: --move-tests moves a test that reads its location only through literal new URL and import.meta.dirname paths, and the moved test still runs [C7,CD64]', async t => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root, git, cli } = await moverFixture(t);
  git(root, 'rm', '-q', '-f', 'test/one.test.js', 'test/helper.js', 'test/journey.test.js');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'test/data'), { recursive: true });
  writeFileSync(join(root, 'test/data/value.txt'), 'seven\n');
  const where = [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { join, resolve } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "import { a } from '../packages/kernel/a.js';",
    "const kernel = fileURLToPath(new URL('../packages/kernel/a.js', import.meta.url));",
    "const data = readFileSync(join(import.meta.dirname, 'data', 'value.txt'), 'utf8');",
    "const root = resolve(import.meta.dirname, '..');",
    "const name = 'value';",
    "const templated = readFileSync(resolve(import.meta.dirname, `data/${name}.txt`), 'utf8');",
    "assert.equal(a, 1);",
    "assert.match(readFileSync(kernel, 'utf8'), /export const a/u);",
    "assert.equal(data, 'seven\\n');",
    "assert.equal(templated, data);",
    "assert.equal(readFileSync(join(root, 'packages/kernel/a.js'), 'utf8'), readFileSync(kernel, 'utf8'));",
    '',
  ].join('\n');
  writeFileSync(join(root, 'test/where.test.js'), where);
  git(root, 'add', '-A');
  const moved = cli('--move-tests', 'kernel');
  assert.equal(moved.failure, null, moved.context);
  assert.match(moved.stdout, /^moved test\/where\.test\.js -> packages\/kernel\/tests\/where\.test\.js$/mu);
  const text = readFileSync(join(root, 'packages/kernel/tests/where.test.js'), 'utf8');
  assert.equal(text, where.replace("'../packages/kernel/a.js'", "'../a.js'").replace("new URL('../packages/kernel/a.js'", "new URL('../a.js'")
    .replace("import.meta.dirname, 'data'", "import.meta.dirname, '../../../test/data'").replace("import.meta.dirname, '..'", "import.meta.dirname, '../../..'")
    .replace('`data/${name}.txt`', '`../../../test/data/${name}.txt`'), 'only path literals changed, each naming the same file');
  const ran = await runMoved(root, 'packages/kernel/tests/where.test.js');
  assert.equal(ran.failure, null, `the moved test still runs\n${ran.context}`);
});

test('clause 1: a bare own-location read is still refused [C7,CD64]', async t => {
  const { cli, state } = await moverFixture(t, { located: true });
  const before = state();
  const refused = cli('--move-tests', 'kernel', 'test/located.test.js');
  assert.equal(refused.status, 1, refused.context);
  assert.match(refused.stderr, /unsafe path test\/located\.test\.js \(reads paths relative to its own location/u);
  assert.equal(state(), before, 'nothing moved');
});

test('clause 2: a move rewrites exact quoted moved paths in the declared test path tables and nothing else [C7,CD64]', async t => {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { TEST_PATH_TABLES_FILE } = await import('../../../../packages/codemap/src/io/cells/placement.js');
  const { root, git, cli } = await moverFixture(t);
  const table = 'packages/verify/src/io/review/tier.js';
  mkdirSync(join(root, 'bin/checks'), { recursive: true });
  mkdirSync(join(root, 'packages/gate/data/tests'), { recursive: true });
  writeFileSync(join(root, TEST_PATH_TABLES_FILE), JSON.stringify([table]));
  mkdirSync(join(root, 'packages/verify/src/io/review'), { recursive: true });
  const tableText = "export const HEAVY = ['test/one.test.js', \"test/journey.test.js\"];\n// test/one.test.js stays in this comment\nexport const NOTE = 'see test/one.test.js';\n";
  writeFileSync(join(root, table), tableText);
  writeFileSync(join(root, 'bin/checks-notes.json'), '{ "test/one.test.js": 1 }\n');
  git(root, 'add', '-A');
  const moved = cli('--move-tests', 'kernel');
  assert.equal(moved.failure, null, moved.context);
  assert.equal(readFileSync(join(root, table), 'utf8'), tableText.replace("'test/one.test.js'", "'packages/kernel/tests/one.test.js'"),
    'only the exact quoted moved path changed');
  assert.equal(readFileSync(join(root, 'bin/checks-notes.json'), 'utf8'), '{ "test/one.test.js": 1 }\n', 'an undeclared file is untouched');
  assert.equal(git(root, 'diff', '--name-only'), '', 'the table rewrite is staged');
});

test('clause 1: --place-tests --batches plans helpers separately and cell moves in plan order; clause 2: its dry run applies them [C7,CD64]', async t => {
  const { writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root, cli } = await moverFixture(t);
  const planned = cli('--place-tests', '--batches', '--max', '80');
  assert.equal(planned.failure, null, planned.context);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.batches.map(batch => [batch.cell, batch.files]), [
    ['kernel', ['test/helper.js']],
    ['kernel', ['test/one.test.js']],
    ['store', ['test/journey.test.js']],
    ['app:cli', ['test/cli.test.js']],
  ], 'one cell per batch in plan order; the two-cell test goes to the last of its cells');
  assert.equal(plan.batches[0].tiers.helper, 1);
  assert.equal(plan.batches[2].tiers.component, 1);
  assert.deepEqual(plan.stays, []);
  writeFileSync(join(root, 'batches.json'), planned.stdout);
  const dry = cli('--place-tests', '--batches', '--dry-run', '--plan', 'batches.json');
  assert.equal(dry.failure, null, dry.context);
  assert.deepEqual(JSON.parse(dry.stdout).dryRun.map(row => [row.cell, row.moved, row.planned]), [['kernel', 1, 1], ['kernel', 1, 1], ['store', 1, 1], ['app:cli', 1, 1]]);
  assert.ok(existsSync(join(root, 'packages/kernel/tests/fixtures/helper.js')), 'the shared helper gets its own fixture home');
  for (const file of ['packages/kernel/tests/one.test.js', 'packages/store/tests/journey.test.js', 'apps/cli/tests/cli.test.js']) {
    assert.ok(existsSync(join(root, file)), `${file} is home`);
    const ran = await runMoved(root, file);
    assert.equal(ran.failure, null, `${file} still runs after its batch\n${ran.context}`);
  }
});


test('clause 1: --helpers moves one shared helper and repoints importers in two cells; unsafe location reads refuse [C7,CD64]', async t => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root, git, cli, state } = await moverFixture(t);
  writeFileSync(join(root, 'test/unsafe-helper.js'), "import { a } from '../packages/kernel/a.js'; export const where = [a, import.meta.dirname];\n");
  git(root, 'add', 'test/unsafe-helper.js');
  const before = state();
  const unsafe = cli('--move-tests', 'kernel', '--helpers', 'test/unsafe-helper.js');
  assert.notEqual(unsafe.status, 0, 'unsupported helper location reads refuse');
  assert.match(unsafe.stderr, /CELLS_TESTS_UNSAFE|reads paths relative to its own location/u);
  assert.equal(state(), before, 'refusal moves nothing');
  const moved = cli('--move-tests', 'kernel', '--helpers', 'test/helper.js');
  assert.equal(moved.failure, null, moved.context);
  assert.match(moved.stdout, /moved test\/helper\.js -> packages\/kernel\/tests\/fixtures\/helper\.js/u);
  for (const file of ['test/one.test.js', 'test/journey.test.js']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /packages\/kernel\/tests\/fixtures\/helper\.js/u);
    const run = await runMoved(root, file);
    assert.equal(run.failure, null, run.context);
  }
});
