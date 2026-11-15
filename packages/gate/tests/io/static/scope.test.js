/** Gate analysis judges an item's changed files only, and keeps a green part once per item head [C7,5814]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { analysisChange } from '../../../src/io/static/scope.js';
import { analysisKey } from '../../../src/io/static/scope.js';
import { analysisScope } from '../../../src/io/static/scope.js';
import { readAnalysisMemo } from '../../../src/io/static/scope.js';
import { staticScopeFromEnv } from '../../../src/io/static/scope.js';
import { writeAnalysisMemo } from '../../../src/io/static/scope.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const sandboxes = [];
after(() => { for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true }); });

/** A fresh private fixture tree, removed after the file's tests. */
function sandbox(prefix) {
  const tree = privateFixtureFiles(prefix);
  sandboxes.push(tree.root);
  return tree;
}

/** A real repository whose main holds the checker folders and two sources, with a helper to commit files. */
function repo() {
  const tree = sandbox('pullboard-analysis-scope-'), root = tree.root;
  const git = (...args) => runFixtureGit(args, { cwd: root });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) tree.write(path, text);
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const main = commit({ 'packages/gate/src/check.js': 'export const rule = 1;\n', 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 1;\n' }, 'main');
  return { root, git, commit, main };
}

test('clause 1: a change of sources is judged on its paths alone; a whole-repo input or a deletion runs the whole tree [C7]', () => {
  assert.deepEqual(analysisScope([{ path: 'src/b.js', status: 'M' }, { path: 'src/a.js', status: 'A' }]), { full: false, files: ['src/a.js', 'src/b.js'] });
  for (const path of ['pullboard.json', 'package.json', 'DOCTRINE.md', 'packages/gate/data/baselines/test-waits-baseline.json']) {
    assert.equal(analysisScope([{ path: 'src/a.js', status: 'M' }, { path, status: 'M' }]).full, true, path);
  }
  assert.match(analysisScope([{ path: 'src/a.js', status: 'D' }]).reason, /deleted/u);
  // The static command reads the paths from its environment; anything else is a whole-tree run.
  assert.deepEqual(staticScopeFromEnv({ PULLBOARD_STATIC_SCOPE: '["src/a.js"]' }), ['src/a.js']);
  assert.equal(staticScopeFromEnv({}), null);
  assert.equal(staticScopeFromEnv({ PULLBOARD_STATIC_SCOPE: '{}' }), null);
});

test('clause 1: given changed paths, a static class that reads none of them is not run, and doctrine runs only touched rules [C7]', () => {
  const named = Object.fromEntries(STATIC_TREE_CHECKS.map(check => [check.name, check]));
  assert.ok(STATIC_TREE_CHECKS.every(check => typeof check.reads === 'function'), 'every class names what it reads');
  // A source-only change skips the test-file classes and the CLI catalog check; a docs change skips every source class.
  assert.equal(named['test-waits'].reads('packages/gate/src/io/a.js'), false);
  assert.equal(named['test-waits'].reads('packages/gate/tests/io/a.test.js'), true);
  assert.equal(named['prose-commands'].reads('packages/gate/src/io/a.js'), false);
  // 4ecd45f084 made layout a static class that reads every path, so a docs change selects it beside doctrine.
  assert.deepEqual(STATIC_TREE_CHECKS.filter(check => check.reads('docs/guide.md')).map(check => check.name), ['layout', 'doctrine']);
  // The file-local import-style class reads only the changed sources.
  const sources = [{ file: 'src/a.js', source: 'export const a = 1;\n' }, { file: 'src/b.js', source: 'export const b = 1;\n' }], read = [];
  const memory = { changed: ['src/b.js'], cache: () => ({ get: file => { read.push(file); return []; } }) };
  assert.deepEqual(named['import-style'].run('/nowhere', sources, memory), []);
  assert.deepEqual(read, ['src/b.js']);
});

test('clause 2: a kept result is found again for the same head and retired when the head or main under a changed path moves [C7]', () => {
  const box = repo(), home = sandbox('pullboard-analysis-memo-').root;
  box.git('checkout', '-q', '-b', 'item');
  const head = box.commit({ 'src/a.js': 'export const a = 2;\n' }, 'item');
  const change = analysisChange(box.root, box.main, head);
  assert.deepEqual(change.changes, [{ path: 'src/a.js', status: 'M' }]);
  const key = analysisKey(box.root, { kind: 'static', main: box.main, source: head, raw: change.raw, definition: 'node checks.js' });
  assert.equal(readAnalysisMemo(key, { home }), null);
  writeAnalysisMemo(key, { green: true }, { home });
  // A resubmit of the same head computes the same key and finds the green result.
  const again = analysisChange(box.root, box.main, head);
  assert.deepEqual(readAnalysisMemo(analysisKey(box.root, { kind: 'static', main: box.main, source: head, raw: again.raw, definition: 'node checks.js' }), { home }).result, { green: true });
  // A new head, another command, or main moving its checker code each miss.
  const next = box.commit({ 'src/a.js': 'export const a = 3;\n' }, 'item again');
  assert.notEqual(analysisKey(box.root, { kind: 'static', main: box.main, source: next, raw: analysisChange(box.root, box.main, next).raw, definition: 'node checks.js' }), key);
  assert.notEqual(analysisKey(box.root, { kind: 'static', main: box.main, source: head, raw: change.raw, definition: 'node other.js' }), key);
  box.git('checkout', '-q', 'main');
  const tooling = box.commit({ 'packages/gate/src/check.js': 'export const rule = 2;\n' }, 'main tooling');
  assert.notEqual(analysisKey(box.root, { kind: 'static', main: tooling, source: head, raw: analysisChange(box.root, tooling, head).raw, definition: 'node checks.js' }), key);
  // A doctrine hold is keyed by the change against current main: main moving elsewhere keeps it, main moving a changed path retires it.
  const doctrine = (main) => analysisKey(box.root, { kind: 'doctrine', main, source: head, raw: analysisChange(box.root, main, head).mainRaw, definition: {}, mainPaths: ['DOCTRINE.md'] });
  const before = doctrine(tooling);
  const elsewhere = box.commit({ 'src/b.js': 'export const b = 2;\n' }, 'main elsewhere');
  assert.equal(doctrine(elsewhere), before);
  const under = box.commit({ 'src/a.js': 'export const a = 9;\n' }, 'main under the change');
  assert.notEqual(doctrine(under), before);
});
