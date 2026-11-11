/** @pullboard-test-input source-tree */
/** A leaf move preserves behavior and reverses without overwriting unrelated bytes [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import {
  readPathMap,
  inventoryBuildCount,
} from '../../../../packages/codemap/index.js';
import { cellsMove } from '../../../../packages/codemap/src/io/cells/move/tool.js';
import { checkMoved } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

/** Execute real Git with private fixture identity and no inherited repository selector. */
function git(root, ...args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/u.test(key)) delete env[key];
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Build an actual committed ESM leaf with a relative dependency and executable mode. */
function fixture(t, source = "import { number } from './number.js';\nexport const value = number + 1;\n") {
  // macOS tmpdir is a symlink; the tool requires canonical custody, so the fixture supplies the real path.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'pb-cell-move-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const custody = join(outer, 'custody');
  mkdirSync(root); mkdirSync(custody); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"type":"module","bin":"src/leaf.js"}\n');
  writeFileSync(join(root, 'src/leaf.js'), source);
  chmodSync(join(root, 'src/leaf.js'), 0o755);
  writeFileSync(join(root, 'src/number.js'), 'export const number = 41;\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial fixture');
  const input = { root, from: 'src/leaf.js', to: 'packages/leaf/src/core/leaf.js', frontDoor: 'packages/leaf/index.js', purpose: 'Expose the leaf value.' };
  return { root, custody, input };
}

/** Run the real module graph in a fresh child, without inherited test-worker context. */
function value(root, path) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify('./' + path)})).value)`], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('leaf move and independent journal inverse restore exact tree and modes [C7]', t => {
  const { root, custody, input } = fixture(t);
  const before = git(root, 'write-tree');
  const original = readFileSync(join(root, input.from));
  const plan = cellsMove.plan(input);
  const result = cellsMove.apply(plan, custody);
  assert.equal(value(root, input.frontDoor), '42\n');
  assert.equal(value(root, input.from), '42\n');
  assert.equal(statSync(join(root, input.to)).mode & 0o777, 0o755);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/path-map/leaf.json'))), { 'src/leaf.js': input.to });
  assert.match(readFileSync(join(root, input.to), 'utf8'), /\.\.\/\.\.\/\.\.\/\.\.\/src\/number\.js/u);
  cellsMove.undo(result.record);
  assert.equal(git(root, 'write-tree'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(readFileSync(join(root, input.from)), original);
  assert.equal(existsSync(join(root, 'packages')), false);
  assert.equal(existsSync(join(root, 'bin')), false);
});

test('a move rewrites actual fixture read operands, preserves destinations and undoes every test byte [C7]', t => {
  const { root, custody, input } = fixture(t, 'export const value = 42;\n');
  mkdirSync(join(root, 'test'));
  const source = [
    "import assert from 'node:assert/strict';",
    "import { readFileSync, writeFileSync, mkdirSync, cpSync, copyFileSync } from 'node:fs';",
    "mkdirSync(new URL('../copied/', import.meta.url));",
    "/** The destination remains a fixture identity, independent of production source relocation. */",
    "function put(path, bytes) { writeFileSync(new URL('../copied/' + path, import.meta.url), bytes); }",
    "put('leaf.js', readFileSync(new URL('../src/leaf.js', import.meta.url)));",
    "cpSync(new URL('../src/leaf.js', import.meta.url), new URL('../copied/cp.js', import.meta.url));",
    "copyFileSync(new URL('../src/leaf.js', import.meta.url), new URL('../copied/copy.js', import.meta.url));",
    "assert.equal(readFileSync(new URL('../copied/leaf.js', import.meta.url), 'utf8'), 'export const value = 42;\\n');",
    "assert.equal(readFileSync(new URL('../copied/cp.js', import.meta.url), 'utf8'), 'export const value = 42;\\n');",
    "assert.equal(readFileSync(new URL('../copied/copy.js', import.meta.url), 'utf8'), 'export const value = 42;\\n');",
    "console.log('fixture copies actual body');",
  ].join('\n') + '\n';
  const file = 'test/copy-case.test.js';
  writeFileSync(join(root, file), source); chmodSync(join(root, file), 0o755);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'real copy fixture');
  const tree = git(root, 'write-tree');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  assert.deepEqual(result.rewrittenTests, [file]);
  const rewritten = readFileSync(join(root, file), 'utf8');
  assert.ok(rewritten.includes("put('leaf.js', readFileSync("), 'fixture destination is unchanged');
  assert.ok(rewritten.includes("new URL('../copied/cp.js', import.meta.url)"), 'copy destination is unchanged');
  assert.equal(rewritten.split('export const value = 42;\\n').length, 4, 'every original assertion byte remains');
  const plan = { cells: [{ name: 'leaf', frontDoor: input.frontDoor, paths: [[input.from, input.to]] }] };
  const inventoriesBefore = inventoryBuildCount();
  assert.deepEqual(checkMoved(root, plan, 'leaf'), []);
  assert.equal(inventoryBuildCount() - inventoriesBefore, 1, 'the moved check shares one repository inventory');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = runFixtureChild(process.execPath, [join(root, file)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  assert.match(child.stdout, /fixture copies actual body/u);
  rmSync(join(root, 'copied'), { recursive: true });
  writeFileSync(join(root, file), source);
  assert.ok(checkMoved(root, plan, 'leaf').some(problem => problem.includes(file)), 'skipping the rewrite fails by test file');
  writeFileSync(join(root, file), rewritten);
  cellsMove.undo(result.record);
  assert.equal(git(root, 'write-tree'), tree);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(root, file), 'utf8'), source);
  assert.equal(statSync(join(root, file)).mode & 0o777, 0o755);
});

test('fixture rewrite custody refuses an unexpected test edit and preserves its journal [C7]', t => {
  const { root, custody, input } = fixture(t, 'export const value = 42;\n');
  mkdirSync(join(root, 'test'));
  const file = 'test/read.test.js';
  writeFileSync(join(root, file), "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../src/leaf.js', import.meta.url));\n");
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'tracked read fixture');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  writeFileSync(join(root, file), '// unexpected concurrent edit\n');
  assert.throws(() => cellsMove.undo(result.record), /changed after apply/u);
  assert.equal(readFileSync(join(root, file), 'utf8'), '// unexpected concurrent edit\n');
  assert.ok(existsSync(result.record));
  rmSync(join(root, file));
  symlinkSync('missing-private-reader.js', join(root, file));
  const plan = { cells: [{ name: 'leaf', frontDoor: input.frontDoor, paths: [[input.from, input.to]] }] };
  assert.ok(checkMoved(root, plan, 'leaf').some(problem => problem.includes(file) && problem.includes('cannot prove')),
    'a dangling tracked reader is reported before attempting to read through it');
});

for (const shape of ['braced constant', 'unbraced inline']) test(`a ${shape} fixture list preserves destinations while its copy source moves [C7]`, t => {
  const { root, custody, input } = fixture(t, 'export const value = 42;\n');
  mkdirSync(join(root, 'test'));
  const file = 'test/list-copy.test.js';
  const source = [
    "import { copyFileSync as copy, mkdirSync, readFileSync } from 'node:fs';",
    "mkdirSync(new URL('../copied/', import.meta.url));",
    ...(shape === 'braced constant' ? ["const files = ['leaf.js', 'number.js'];", 'for (const file of files) {']
      : ["for (const file of ['leaf.js', 'number.js'])"]),
    '  copy(new URL(`../src/${file}`, import.meta.url), new URL(`../copied/${file}`, import.meta.url));',
    ...(shape === 'braced constant' ? ['}'] : []),
    "console.log(readFileSync(new URL('../copied/leaf.js', import.meta.url), 'utf8'));",
    "console.log(readFileSync(new URL('../copied/number.js', import.meta.url), 'utf8'));",
  ].join('\n') + '\n';
  writeFileSync(join(root, file), source);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'finite shared fixture list');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  const rewritten = readFileSync(join(root, file), 'utf8');
  assert.ok(rewritten.includes(shape === 'braced constant' ? "const files = ['leaf.js', 'number.js'];"
    : "for (const file of ['leaf.js', 'number.js'])"));
  assert.ok(rewritten.includes('new URL(`../copied/${file}`, import.meta.url)'), 'the shared destination expression remains exact');
  const plan = { cells: [{ name: 'leaf', frontDoor: input.frontDoor, paths: [[input.from, input.to]] }] };
  assert.deepEqual(checkMoved(root, plan, 'leaf'), [], 'the independent proof recognizes the rewritten finite source table');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = runFixtureChild(process.execPath, [join(root, file)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  assert.match(child.stdout, /export const value = 42/u);
  assert.match(child.stdout, /export const number = 41/u);
  rmSync(join(root, 'copied'), { recursive: true });
  cellsMove.undo(result.record);
  assert.equal(readFileSync(join(root, file), 'utf8'), source);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('historical four-file v2 custody remains reversible after fixture-aware moves [C7]', t => {
  const { root, custody, input } = fixture(t);
  const tree = git(root, 'write-tree');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  const current = JSON.parse(readFileSync(result.record, 'utf8'));
  const { digest: _digest, testFiles: _testFiles, ...legacy } = current;
  legacy.version = 2;
  const record = join(custody, 'historical-v2.json');
  writeFileSync(record, JSON.stringify({ ...legacy, digest: createHash('sha256').update(JSON.stringify(legacy)).digest('hex') }));
  cellsMove.undo(record);
  assert.equal(git(root, 'write-tree'), tree);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('lookalike calls, comments, assertions and synthetic fixture code are not production source copies [C7]', t => {
  const { root, custody, input } = fixture(t, 'export const value = 42;\n');
  mkdirSync(join(root, 'test'));
  const file = 'test/lookalike.test.js';
  const source = [
    "import assert from 'node:assert/strict';",
    '/** This lookalike receives text; it never reads the filesystem. */',
    'function readFileSync(path) { return path; }',
    "assert.equal(readFileSync('../src/leaf.js'), '../src/leaf.js');",
    "// readFileSync(new URL('../src/leaf.js', import.meta.url));",
    'const fixtureCode = "readFileSync(new URL(\'../src/leaf.js\', import.meta.url));";',
    "assert.ok(fixtureCode.includes('../src/leaf.js'));",
  ].join('\n') + '\n';
  writeFileSync(join(root, file), source);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'non-copy source spellings');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  assert.deepEqual(result.rewrittenTests, []);
  assert.equal(readFileSync(join(root, file), 'utf8'), source);
  const plan = { cells: [{ name: 'leaf', frontDoor: input.frontDoor, paths: [[input.from, input.to]] }] };
  assert.deepEqual(checkMoved(root, plan, 'leaf'), []);
  cellsMove.undo(result.record);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fixture joins retain rooted later segments while resolve keeps its absolute reset [C7]', t => {
  const { root, custody, input } = fixture(t, 'export const value = 42;\n');
  mkdirSync(join(root, 'test'));
  const file = 'test/join-copy.test.js';
  const external = "function external() { return fs.readFileSync(path.resolve(import.meta.dirname, '..', '/src/leaf.js')); }";
  const source = [
    "import assert from 'node:assert/strict';",
    "import * as fs from 'node:fs';",
    "import * as path from 'node:path';",
    "const body = fs.readFileSync(path.join(import.meta.dirname, '..', '/src/leaf.js'), 'utf8');",
    "assert.equal(body, 'export const value = 42;\\n');",
    "assert.equal(path.resolve(import.meta.dirname, '..', '/src/leaf.js'), '/src/leaf.js');",
    '/** An external absolute read is deliberately outside the repository move. */',
    external,
    "console.log('joined copy reads actual body');",
  ].join('\n') + '\n';
  writeFileSync(join(root, file), source);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'native join versus resolve fixture');
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  assert.deepEqual(result.rewrittenTests, [file]);
  const rewritten = readFileSync(join(root, file), 'utf8');
  assert.ok(rewritten.includes(external), 'an actual absolute resolve read is unchanged');
  const plan = { cells: [{ name: 'leaf', frontDoor: input.frontDoor, paths: [[input.from, input.to]] }] };
  assert.deepEqual(checkMoved(root, plan, 'leaf'), []);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = runFixtureChild(process.execPath, [join(root, file)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  assert.match(child.stdout, /joined copy reads actual body/u);
  writeFileSync(join(root, file), source);
  assert.ok(checkMoved(root, plan, 'leaf').some(problem => problem.includes(file)), 'the missed join is independently refused');
  writeFileSync(join(root, file), rewritten);
  cellsMove.undo(result.record);
  assert.equal(readFileSync(join(root, file), 'utf8'), source);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

for (const [label, source] of [
  ['default', 'export default 1;\n'],
  ['aliased default', 'const value = 1; export { value as default };\n'],
  ['re-export', "export { number } from './number.js';\n"],
  ['dynamic load', "export const value = import('./number.js');\n"],
  ['asset', "export const value = './asset.txt';\n"],
]) test(`unsupported ${label} leaves the committed tree untouched [C7]`, t => {
  const { root, input } = fixture(t, source);
  assert.throws(() => cellsMove.plan(input), /CELLS_MOVE/u);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('inverse preserves unexpected edited bytes and leaves custody available [C7]', t => {
  const { root, custody, input } = fixture(t);
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  writeFileSync(join(root, input.to), 'unexpected concurrent edit\n');
  assert.throws(() => cellsMove.undo(result.record), /changed after apply/u);
  assert.equal(readFileSync(join(root, input.to), 'utf8'), 'unexpected concurrent edit\n');
  assert.ok(existsSync(result.record));
});

test('nested package scope and non-UTF8 input refuse before mutation [C7]', t => {
  const { root, input } = fixture(t);
  mkdirSync(join(root, 'packages/leaf'), { recursive: true });
  writeFileSync(join(root, 'packages/leaf/package.json'), '{"type":"commonjs"}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'nested scope');
  assert.throws(() => cellsMove.plan(input), /nested package scope/u);
  rmSync(join(root, 'packages'), { recursive: true });
  git(root, 'add', '-A');
  writeFileSync(join(root, input.from), Buffer.from([0xff]));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'non UTF8');
  assert.throws(() => cellsMove.plan(input), /exact UTF-8/u);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('dirty workspace, CommonJS extension and forged postimage cannot mutate source [C7]', t => {
  const { root, custody, input } = fixture(t);
  writeFileSync(join(root, 'unrelated.txt'), 'keep me\n');
  assert.throws(() => cellsMove.plan(input), /clean checkout/u);
  rmSync(join(root, 'unrelated.txt'));
  assert.throws(() => cellsMove.plan({ ...input, to: 'packages/leaf/src/core/leaf.cjs' }), /body must live/u);
  const plan = cellsMove.plan(input);
  const forged = JSON.parse(JSON.stringify(plan));
  forged.after[input.to].bytes = Buffer.from('export const value = 0;\n').toString('base64');
  assert.throws(() => cellsMove.apply(forged, custody), /custody digest changed/u);
  assert.equal(git(root, 'status', '--porcelain'), '');
});


test('rehashed forged inverse cannot bless a concurrent edit as its postimage [C7]', t => {
  const { root, custody, input } = fixture(t);
  const result = cellsMove.apply(cellsMove.plan(input), custody);
  const forged = JSON.parse(readFileSync(result.record, 'utf8'));
  const unexpected = 'export const value = 7;\n';
  writeFileSync(join(root, input.to), unexpected);
  forged.after[input.to].bytes = Buffer.from(unexpected).toString('base64');
  const { digest: _digest, ...payload } = forged;
  forged.digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const record = join(custody, 'forged.json');
  writeFileSync(record, JSON.stringify(forged));
  assert.throws(() => cellsMove.undo(record), /immutable canonical derivation/u);
  assert.equal(readFileSync(join(root, input.to), 'utf8'), unexpected);
});

test('failed apply preserves a concurrently deleted preexisting path map [C7]', t => {
  const { root, custody, input } = fixture(t);
  mkdirSync(join(root, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/leaf.json'), '{}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'existing path map');
  const plan = cellsMove.plan(input);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(custody, 'git');
  const marker = join(custody, 'failed-once');
  writeFileSync(shim, `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const cp = require('node:child_process');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[2] === 'add' && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
    ` fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); fs.unlinkSync(${JSON.stringify(join(root, 'packages/codemap/data/plan/path-map/leaf.json'))}); process.exit(1); }\n` +
    `const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n`);
  chmodSync(shim, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = custody + ':' + previous;
  try {
    assert.throws(() => cellsMove.apply(plan, custody), /retain exact custody/u);
  } finally { process.env.PATH = previous; }
  assert.equal(existsSync(join(root, 'packages/codemap/data/plan/path-map/leaf.json')), false);
  assert.ok(existsSync(join(custody, plan.digest + '.json')));
  assert.match(readFileSync(join(root, input.from), 'utf8'), /^export \*/u);
});


test('explicit export pruning keeps real consumer API and reverses exact source [C7]', t => {
  const { root, custody, input } = fixture(t, 'export const internal = 41;\nexport const value = internal + 1;\n');
  const before = git(root, 'write-tree');
  const result = cellsMove.apply(cellsMove.plan({ ...input, keepExports: ['value'] }), custody);
  assert.equal(value(root, input.frontDoor), '42\n');
  assert.match(readFileSync(join(root, input.to), 'utf8'), /const internal = 41/u);
  assert.doesNotMatch(readFileSync(join(root, input.to), 'utf8'), /export const internal/u);
  cellsMove.undo(result.record);
  assert.equal(git(root, 'write-tree'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});


test('export pruning refuses grouped variable exports rather than leaking extra API [C7]', t => {
  const { root, input } = fixture(t, 'export const value = 42, hidden = 7;\n');
  assert.throws(() => cellsMove.plan({ ...input, keepExports: ['value'] }), /one variable per declaration/u);
  assert.equal(git(root, 'status', '--porcelain'), '');
});


test('committed cell shards combine with root compatibility map and reject conflicts [C7]', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'path-map.json'), JSON.stringify({ 'src/old.js': 'src/leaf.js' }));
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/leaf.json'), JSON.stringify({ 'src/leaf.js': 'packages/leaf/src/core/leaf.js' }));
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/other.json'), JSON.stringify({ 'src/other.js': 'packages/other/src/core/other.js' }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'committed shards');
  const accepted = git(root, 'rev-parse', 'HEAD').trim();
  const map = readPathMap(root);
  assert.equal(map.get('src/old.js'), 'packages/leaf/src/core/leaf.js');
  assert.equal(map.get('src/other.js'), 'packages/other/src/core/other.js');
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/other.json'), JSON.stringify({ 'src/leaf.js': 'packages/other/src/core/other.js' }));
  assert.deepEqual(readPathMap(root), map, 'uncommitted bytes cannot change the selected map');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'conflicting shards');
  assert.throws(() => readPathMap(root), /NO_POLICY/u);
  assert.deepEqual(readPathMap(root, { commit: accepted }), map);
});

test('cycles spanning cell shards fail closed [C7]', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/a.json'), JSON.stringify({ 'src/a.js': 'src/b.js' }));
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/b.json'), JSON.stringify({ 'src/b.js': 'src/a.js' }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'cyclic shards');
  assert.throws(() => readPathMap(root), /NO_POLICY/u);
});


test('the shipped installation includes the first real package and runs its CLI [C7,P3]', t => {
  const outer = mkdtempSync(join(tmpdir(), 'pb-cell-shipped-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const installed = join(outer, 'installed');
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), installed);
  const env = { ...process.env, HOME: join(outer, 'home'), PULLBOARD_HOME: join(outer, 'home/pullboard'), PULLBOARD_MACHINE_HOME: join(outer, 'machine') };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [join(installed, 'apps/cli/pullboard.js'), '--help'], { cwd: installed, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /pullboard/u);
  const body = spawnSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import { serveMcp, refusePersonMove } from './packages/mcp/index.js'; assert.equal(typeof serveMcp, 'function'); assert.throws(() => refusePersonMove('spec_approve'), { code: 'HUMAN_REQUIRED' });"], { cwd: installed, env, encoding: 'utf8' });
  assert.equal(body.status, 0, body.stderr);
});

/** Snapshot every tracked byte, mode and Git status so a rollback is compared to the exact pre-move tree. */
function snapshot(root) {
  const files = git(root, 'ls-files').trim().split('\n').filter(Boolean);
  return {
    index: git(root, 'ls-files', '-s'),
    status: git(root, 'status', '--porcelain=v1', '-z'),
    contents: Object.fromEntries(files.map(file => [file, readFileSync(join(root, file), 'utf8')])),
    packages: existsSync(join(root, 'packages')),
  };
}

test('a late git add failure beside a concurrent source delete restores the exact pre-move tree [C7]', t => {
  const { root, custody, input } = fixture(t);
  const plan = cellsMove.plan(input);
  const preMove = snapshot(root);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(custody, 'git');
  const marker = join(custody, 'failed-once');
  writeFileSync(shim, `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const cp = require('node:child_process');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[2] === 'add' && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
    ` fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); fs.unlinkSync(${JSON.stringify(join(root, input.from))}); process.exit(1); }\n` +
    `const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n`);
  chmodSync(shim, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = custody + ':' + previous;
  try {
    assert.throws(() => cellsMove.apply(plan, custody), /git add failed|retain exact custody/u);
  } finally { process.env.PATH = previous; }
  assert.deepEqual(snapshot(root), preMove);
});
