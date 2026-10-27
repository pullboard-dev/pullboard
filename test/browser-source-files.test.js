/**
 * @pullboard-test-boundary contract
 */
/** Real and memory source boundaries preserve containment and conservative graph failures [C7,O5]. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { testsNeedBrowser } from '../src/browser-admission.js';
import { memoryBrowserSourceFiles, realBrowserSourceFiles, snapshotBrowserSourceFiles, withBrowserSourceFiles } from '../src/browser-source-files.js';

/** Build the same actual source graph and independently described memory tree. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-source-files-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-source-outside-')));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const sources = { 'leaf.js': 'export const safe = true;',
    'test/ordinary.test.js': "import '../leaf.js';", 'test/missing.test.js': "import '../missing.js';",
    'test/directory.test.js': "import '../directory';", 'test/ambiguous.test.js': "import '../choice';",
    'test/inside.test.js': "import '../inside.js';", 'test/outside.test.js': "import '../outside.js';",
    'choice.js': 'export const a = true;', 'choice.mjs': 'export const b = true;' };
  const entries = new Map();
  for (const [path, bytes] of Object.entries(sources)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), bytes);
    entries.set(join(root, path), { kind: 'file', bytes });
  }
  mkdirSync(join(root, 'directory'));
  entries.set(join(root, 'directory'), { kind: 'directory' });
  writeFileSync(join(outside, 'leaf.js'), sources['leaf.js']);
  entries.set(join(outside, 'leaf.js'), { kind: 'file', bytes: sources['leaf.js'] });
  for (const [path, target] of [['inside.js', 'leaf.js'], ['outside.js', join(outside, 'leaf.js')]]) {
    symlinkSync(target, join(root, path));
    entries.set(join(root, path), { kind: 'symlink', target });
  }
  return { root, entries, files: [...Object.keys(sources), 'directory', 'inside.js', 'outside.js'] };
}

for (const implementation of ['real', 'memory', 'snapshot']) {
  test(`source files shared containment and graph contract: ${implementation} [C7,O5]`, async t => {
    const box = fixture(t);
    const adapter = implementation === 'real' ? realBrowserSourceFiles : implementation === 'memory'
      ? memoryBrowserSourceFiles(box.entries) : await snapshotBrowserSourceFiles(box.root, box.files);
    assert.equal((await adapter.stat(join(box.root, 'directory'))).isFile(), false);
    await assert.rejects(adapter.realpath(join(box.root, 'missing.js')), error => error.code === 'ENOENT');
    await assert.rejects(adapter.realpath(join(box.root, 'leaf.js', 'child')), error => error.code === 'ENOTDIR');
    await withBrowserSourceFiles(adapter, async () => {
      for (const [name, expected] of [['ordinary', false], ['inside', false], ['missing', true],
        ['directory', true], ['ambiguous', true], ['outside', true]]) {
        assert.equal(await testsNeedBrowser(box.root, [`test/${name}.test.js`], { byLaunch: true }), expected, name);
      }
    });
    assert.equal(await adapter.readFile(join(box.root, 'leaf.js'), 'utf8'), 'export const safe = true;');
  });
}

test('source snapshots retain captured bytes and never change real-default or concurrent call chains [C7]', async t => {
  const box = fixture(t);
  const snapshot = await snapshotBrowserSourceFiles(box.root, box.files);
  writeFileSync(join(box.root, 'leaf.js'), 'changed after capture');
  assert.equal(await snapshot.readFile(join(box.root, 'leaf.js'), 'utf8'), 'export const safe = true;');
  assert.equal(await realBrowserSourceFiles.readFile(join(box.root, 'leaf.js'), 'utf8'), 'changed after capture');
  await assert.rejects(snapshot.readFile(join(box.root, 'outside.js'), 'utf8'), error => error.code === 'EACCES');
  const actual = await Promise.all([withBrowserSourceFiles(snapshot, async () =>
    (await import('../src/browser-source-files.js')).browserSourceFiles() === snapshot),
  Promise.resolve().then(async () => (await import('../src/browser-source-files.js')).browserSourceFiles() === realBrowserSourceFiles)]);
  assert.deepEqual(actual, [true, true]);
});

for (const implementation of ['real', 'memory', 'snapshot']) {
  test(`aliased source root resolves relative links from their real parent: ${implementation} [C7,O5]`, async t => {
    const box = fixture(t);
    const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-source-alias-')));
    t.after(() => rmSync(aliasParent, { recursive: true, force: true }));
    const alias = join(aliasParent, 'repo');
    symlinkSync(box.root, alias);
    box.entries.set(alias, { kind: 'symlink', target: box.root });
    const target = `../${basename(box.root)}/untracked.js`;
    writeFileSync(join(box.root, 'untracked.js'), 'export const captured = true;');
    symlinkSync(target, join(box.root, 'relative.js'));
    box.entries.set(join(box.root, 'untracked.js'), { kind: 'file', bytes: 'export const captured = true;' });
    box.entries.set(join(box.root, 'relative.js'), { kind: 'symlink', target });
    const adapter = implementation === 'real' ? realBrowserSourceFiles : implementation === 'memory'
      ? memoryBrowserSourceFiles(box.entries) : await snapshotBrowserSourceFiles(alias, ['relative.js']);
    assert.equal(await adapter.realpath(join(alias, 'relative.js')), join(box.root, 'untracked.js'));
    assert.equal(await adapter.readFile(join(alias, 'relative.js'), 'utf8'), 'export const captured = true;');
  });
}
