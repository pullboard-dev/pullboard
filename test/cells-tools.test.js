/** Cell tool prerequisites use real committed graphs and the actual CLI catalogs [C7]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { runFixtureGit } from './fixture-child.js';
import { selectAffectedTests } from '../src/affected-tests.js';
import { testClosures } from '../src/affected-tests.js';
import { repositoryImport } from '../src/import-map.js';
import { styleSources } from '../src/source-inventory.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const MAP = { '#*': './packages/*/index.js', '#*.js': './packages/*.js' };

/** Create isolated files and immutable Git snapshots without inheriting repository hooks. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cell-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cell fixture', GIT_AUTHOR_EMAIL: 'cells@example.com',
    GIT_COMMITTER_NAME: 'Cell fixture', GIT_COMMITTER_EMAIL: 'cells@example.com' };
  /** Execute fixture Git with its own deterministic identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Write a fixture source at a repository-relative path. */
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  /** Commit source so graph readers cannot accidentally read mutable worktree files. */
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'test: cell fixture'); return git('rev-parse', 'HEAD').trim(); };
  git('init', '-q', '-b', 'main');
  put('package.json', JSON.stringify({ type: 'module', imports: MAP }));
  return { root, put, commit };
}

test('named cell imports select package tests and retain map bytes in cache closures [C7]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', 'export const value = 1;\n');
  box.put('packages/sample/tests/helper.js', "export { value } from '#sample';\n");
  box.put('packages/sample/tests/value.test.js', "import './helper.js';\n");
  box.put('test/relative.test.js', "import '../packages/sample/index.js';\n");
  box.put('test/unrelated.test.js', 'import assert from \'node:assert/strict\'; assert.ok(true);\n');
  const base = box.commit();
  box.put('packages/sample/index.js', 'export const value = 2;\n');
  const commit = box.commit();
  const selected = selectAffectedTests(box.root, { base, commit });
  assert.equal(selected.full, false);
  assert.deepEqual(selected.files, ['packages/sample/tests/value.test.js', 'test/relative.test.js']);
  const closure = testClosures(box.root, commit).closures.get('packages/sample/tests/value.test.js');
  assert.ok(closure.files.includes('package.json'));
  assert.ok(closure.files.includes('packages/sample/index.js'));
  assert.ok(closure.helpers.includes('packages/sample/tests/helper.js'));
  box.put('package.json', '{"type":"module","imports":{}}');
  assert.deepEqual(testClosures(box.root, commit).closures.get('packages/sample/tests/value.test.js'), closure);
  const broken = box.commit();
  assert.equal(testClosures(box.root, broken).closures.get('packages/sample/tests/value.test.js').files, null);
});

test('Node-valid wildcard precedence resolves deep cell paths and refuses unsupported targets [C7]', t => {
  const box = fixture(t);
  box.put('packages/sample/deep.js', 'export const value = 7;\n');
  box.put('packages/sample/index.js', "export { value } from '#sample/deep.js';\n");
  assert.equal(repositoryImport('test/a.js', '#sample/deep.js', MAP), 'packages/sample/deep.js');
  assert.equal(repositoryImport('test/a.js', '#sample', MAP), 'packages/sample/index.js');
  assert.equal(repositoryImport('test/a.js', '#missing', {}), null);
  assert.equal(repositoryImport('test/a.js', '#bad', { '#bad': '../outside.js' }), null);
  assert.equal(repositoryImport('test/a.js', '#bad', { '#bad': { default: './other.js' } }), null);
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', "import {value} from '#sample'; console.log(value)"], { cwd: box.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '7');
});

test('source style inventories package tests and apps alongside legacy source [C7]', t => {
  const box = fixture(t);
  box.put('src/legacy.js', 'export {};');
  box.put('packages/sample/tests/value.test.js', "import { one, two } from '#sample';");
  box.put('apps/sample/index.js', "import '#sample';");
  box.put('packages/sample/node_modules/ignored.js', 'invalid');
  const sources = styleSources(box.root);
  assert.deepEqual(sources.map(row => row.file), ['apps/sample/index.js', 'packages/sample/tests/value.test.js', 'src/legacy.js']);
  const helper = new URL('../src/static-import-style.js', import.meta.url).href;
  const script = `import {importStyleViolations} from ${JSON.stringify(helper)}; console.log(JSON.stringify(importStyleViolations(${JSON.stringify(sources)})));`;
  const result = runFixtureChild(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { cwd: box.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ file: 'packages/sample/tests/value.test.js', line: 1, count: 2 }]);
});

test('actual CLI help and API catalog work through a named cell command front door [C7]', t => {
  const box = fixture(t);
  cpSync(join(REPO, 'src'), join(box.root, 'src'), { recursive: true });
  cpSync(join(REPO, 'bin'), join(box.root, 'bin'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  box.put('package.json', JSON.stringify({ ...manifest, imports: MAP }));
  box.put('packages/sample/index.js', readFileSync(join(REPO, 'src/commands/version.js'), 'utf8'));
  box.put('src/commands/version.js', "export { run } from '#sample';\n");
  /** Exercise the real command registry through its named package shim. */
  const run = (...args) => runFixtureChild(process.execPath, ['bin/pullboard.js', ...args], { cwd: box.root, encoding: 'utf8' });
  const version = run('version', '--json');
  assert.equal(version.status, 0, version.stderr);
  const output = JSON.parse(version.stdout);
  assert.equal(output.release, manifest.version);
  const help = run('help', 'version', '--json');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /version/u);
  const script = "import {JSON_SHAPES} from './src/json.js'; console.log(JSON.stringify(JSON_SHAPES.commands.version));";
  const catalog = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.root, encoding: 'utf8' });
  assert.equal(catalog.status, 0, catalog.stderr);
  const shape = JSON.parse(catalog.stdout);
  for (const key of Object.keys(shape.required)) assert.ok(Object.hasOwn(output, key), key);
});
