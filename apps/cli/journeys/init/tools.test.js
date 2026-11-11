/** @pullboard-test-input source-tree */
/** Cell tool prerequisites use real committed graphs and the actual CLI catalogs [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { selectAffectedTests } from '../../../../packages/gate/index.js';
import { testClosures } from '../../../../packages/gate/index.js';
import { repositoryImport } from '../../../../packages/codemap/index.js';
import { styleSources } from '../../../../packages/codemap/index.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { copyPackageSubset } from '../../tests/fixtures/copy.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
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
  const helper = new URL('../../../../packages/gate/index.js', import.meta.url).href;
  const script = `import {importStyleViolations} from ${JSON.stringify(helper)}; console.log(JSON.stringify(importStyleViolations(${JSON.stringify(sources)})));`;
  const result = runFixtureChild(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { cwd: box.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ file: 'packages/sample/tests/value.test.js', line: 1, count: 2 }]);
});

test('actual CLI help and API catalog work through a named cell command front door [C7]', t => {
  const box = fixture(t);
  copyPackageFiles(REPO, box.root);
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  box.put('package.json', JSON.stringify({ ...manifest, imports: { ...MAP, '#sample': './packages/sample/src/shell/commands/version.js' } }));
  copyPackageSubset(REPO, box.root, [{ path: 'apps/cli/src/io/commands/version.js', as: 'packages/sample/src/shell/commands/version.js' }]);
  box.put('apps/cli/src/io/commands/version.js', "export { run } from '#sample';\n");
  /** Exercise the real command registry through its named package shim. */
  const run = (...args) => runFixtureChild(process.execPath, ['apps/cli/pullboard.js', ...args], { cwd: box.root, encoding: 'utf8' });
  const version = run('version', '--json');
  assert.equal(version.status, 0, version.stderr);
  const output = JSON.parse(version.stdout);
  assert.equal(output.release, manifest.version);
  const help = run('help', 'version', '--json');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /version/u);
  const script = "import {JSON_SHAPES} from './packages/config/index.js'; console.log(JSON.stringify(JSON_SHAPES.commands.version));";
  const catalog = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.root, encoding: 'utf8' });
  assert.equal(catalog.status, 0, catalog.stderr);
  const shape = JSON.parse(catalog.stdout);
  for (const key of Object.keys(shape.required)) assert.ok(Object.hasOwn(output, key), key);
});


test('an installed cell resolver upgrade invalidates memo keys outside the candidate tree [C7]', t => {
  const box = fixture(t);
  box.put('packages/sample/index.js', 'export const value = 1;\n');
  box.put('packages/sample/tests/value.test.js', "import '#sample';\n");
  box.put('apps/cli/src/io/run/tests.js', 'export {};\n');
  box.put('src/test-action-reporter.js', 'export {};\n');
  const commit = box.commit();
  const tool = mkdtempSync(join(tmpdir(), 'pullboard-installed-cell-tool-'));
  t.after(() => rmSync(tool, { recursive: true, force: true }));
  copyPackageFiles(REPO, tool);
  const module = pathToFileURL(join(tool, 'packages/gate/src/io/test/action/cache.js')).href;
  const script = `import {testActionKeys} from ${JSON.stringify(module)}; const keys = await testActionKeys(${JSON.stringify(box.root)}, {commit:${JSON.stringify(commit)}}); console.log(JSON.stringify(keys.get('packages/sample/tests/value.test.js')));`;
  /** Fresh processes reload the private installed analyzer while the candidate's Git tree stays fixed. */
  const key = () => {
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.match(record.key, /^[a-f0-9]{64}$/u, record.reason);
    return record.key;
  };
  const resolver = join(tool, 'packages/codemap/src/logic/imports.js');
  const analyzer = join(tool, 'packages/gate/src/io/test/action/cache.js');
  const fixedAnalyzer = readFileSync(analyzer, 'utf8');
  const originalResolver = readFileSync(resolver, 'utf8');
  const revisedResolver = originalResolver + '\n// Installed resolver revision: candidate tree deliberately unchanged.\n';
  // Reproduce the old installed analyzer in this private copy only; the owning checkout stays untouched.
  const oldAnalyzer = fixedAnalyzer.replace(", '../../../../../codemap/src/logic/imports.js'", '');
  assert.notEqual(oldAnalyzer, fixedAnalyzer, 'the old control actually removes the installed resolver input');
  writeFileSync(analyzer, oldAnalyzer);
  const oldBefore = key();
  writeFileSync(resolver, revisedResolver);
  const oldAfter = key();
  const assertion = `import assert from 'node:assert/strict'; assert.notEqual(${JSON.stringify(oldBefore)}, ${JSON.stringify(oldAfter)}, 'the old installed analyzer must invalidate a changed resolver');`;
  const red = runFixtureChild(process.execPath, ['--input-type=module', '-e', assertion], { cwd: box.root, encoding: 'utf8' });
  assert.equal(red.status, 1, 'the actual old-tool API results fail the new invariant');
  assert.match(red.stderr, /old installed analyzer/u);
  writeFileSync(analyzer, fixedAnalyzer);
  writeFileSync(resolver, originalResolver);
  const before = key();
  assert.equal(key(), before, 'unchanged installed analysis retains the same memo identity');
  writeFileSync(resolver, revisedResolver);
  assert.notEqual(key(), before, 'exact installed resolver bytes belong to the analyzer policy identity');
});

test('relative mjs-only graphs retain focused selection without a root package manifest [C7]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'package.json'));
  box.put('lib/value.mjs', 'export const value = 1;\n');
  box.put('test/value.test.mjs', "import '../lib/value.mjs';\n");
  box.put('test/other.test.mjs', "import 'node:assert/strict';\n");
  const base = box.commit();
  box.put('lib/value.mjs', 'export const value = 2;\n');
  const commit = box.commit();
  const selected = selectAffectedTests(box.root, { base, commit });
  assert.equal(selected.full, false, selected.reason);
  assert.deepEqual(selected.files, ['test/value.test.mjs']);
});
