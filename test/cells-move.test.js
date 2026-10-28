/** A leaf move preserves behavior and reverses without overwriting unrelated bytes [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../src/package-files.js';
import { readPathMap } from '../src/path-map.js';
import { cellsMove } from '../bin/cells-move-tool.js';

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
  const outer = mkdtempSync(join(tmpdir(), 'pb-cell-move-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const custody = join(outer, 'custody');
  mkdirSync(root); mkdirSync(custody); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
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
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'bin/cells-plan/path-map/leaf.json'))), { 'src/leaf.js': input.to });
  assert.match(readFileSync(join(root, input.to), 'utf8'), /\.\.\/\.\.\/\.\.\/\.\.\/src\/number\.js/u);
  cellsMove.undo(result.record);
  assert.equal(git(root, 'write-tree'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(readFileSync(join(root, input.from)), original);
  assert.equal(existsSync(join(root, 'packages')), false);
  assert.equal(existsSync(join(root, 'bin')), false);
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
  mkdirSync(join(root, 'bin/cells-plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'bin/cells-plan/path-map/leaf.json'), '{}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'existing path map');
  const plan = cellsMove.plan(input);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(custody, 'git');
  const marker = join(custody, 'failed-once');
  writeFileSync(shim, `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const cp = require('node:child_process');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[2] === 'add' && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
    ` fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); fs.unlinkSync(${JSON.stringify(join(root, 'bin/cells-plan/path-map/leaf.json'))}); process.exit(1); }\n` +
    `const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n`);
  chmodSync(shim, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = custody + ':' + previous;
  try {
    assert.throws(() => cellsMove.apply(plan, custody), /retain exact custody/u);
  } finally { process.env.PATH = previous; }
  assert.equal(existsSync(join(root, 'bin/cells-plan/path-map/leaf.json')), false);
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
  mkdirSync(join(root, 'bin/cells-plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'path-map.json'), JSON.stringify({ 'src/old.js': 'src/leaf.js' }));
  writeFileSync(join(root, 'bin/cells-plan/path-map/leaf.json'), JSON.stringify({ 'src/leaf.js': 'packages/leaf/src/core/leaf.js' }));
  writeFileSync(join(root, 'bin/cells-plan/path-map/other.json'), JSON.stringify({ 'src/other.js': 'packages/other/src/core/other.js' }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'committed shards');
  const accepted = git(root, 'rev-parse', 'HEAD').trim();
  const map = readPathMap(root);
  assert.equal(map.get('src/old.js'), 'packages/leaf/src/core/leaf.js');
  assert.equal(map.get('src/other.js'), 'packages/other/src/core/other.js');
  writeFileSync(join(root, 'bin/cells-plan/path-map/other.json'), JSON.stringify({ 'src/leaf.js': 'packages/other/src/core/other.js' }));
  assert.deepEqual(readPathMap(root), map, 'uncommitted bytes cannot change the selected map');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'conflicting shards');
  assert.throws(() => readPathMap(root), /NO_POLICY/u);
  assert.deepEqual(readPathMap(root, { commit: accepted }), map);
});

test('cycles spanning cell shards fail closed [C7]', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'bin/cells-plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'bin/cells-plan/path-map/a.json'), JSON.stringify({ 'src/a.js': 'src/b.js' }));
  writeFileSync(join(root, 'bin/cells-plan/path-map/b.json'), JSON.stringify({ 'src/b.js': 'src/a.js' }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'cyclic shards');
  assert.throws(() => readPathMap(root), /NO_POLICY/u);
});


test('the shipped installation includes the first real package and runs its CLI [C7,P3]', t => {
  const outer = mkdtempSync(join(tmpdir(), 'pb-cell-shipped-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const installed = join(outer, 'installed');
  copyPackageFiles(resolve(import.meta.dirname, '..'), installed);
  const env = { ...process.env, HOME: join(outer, 'home'), PULLBOARD_HOME: join(outer, 'home/pullboard'), PULLBOARD_MACHINE_HOME: join(outer, 'machine') };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [join(installed, 'bin/pullboard.js'), '--help'], { cwd: installed, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /pullboard/u);
});
