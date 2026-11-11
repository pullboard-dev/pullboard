/** A checker's fingerprint comes from the git index: the same tree gives the same one, and a changed or new file moves it [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../apps/cli/tests/fixtures/testkit.js';
import { checkCommandDefinition } from '../../src/io/check/definition.js';
import { definitionUnchanged } from '../../src/io/check/definition.js';
import { scanImports } from '../../src/io/check/definition.js';

/** A committed checker that imports one helper. */
function fixture() {
  const graph = fixtureCommittedGraph('definition-');
  graph.put('a.js', "import './b.js';\n");
  graph.put('b.js', 'export const x = 1;\n');
  graph.commit();
  return graph;
}

/** The fingerprint of a.js and everything it loads. */
function fingerprint(root) {
  return JSON.stringify(checkCommandDefinition(root, [], [`${root}/a.js`]));
}

test('the same tree gives the same fingerprint, with or without .git, and a dirty file moves it [C7]', () => {
  const graph = fixture();
  const clean = fingerprint(graph.root);
  assert.equal(fingerprint(graph.root), clean);
  const copy = privateFixtureFiles('definition-copy-');
  copy.write('a.js', "import './b.js';\n");
  copy.write('b.js', 'export const x = 1;\n');
  assert.equal(fingerprint(copy.root), clean, 'the walk without .git must agree with the index');
  graph.put('b.js', 'export const x = 2;\n');
  assert.notEqual(fingerprint(graph.root), clean);
  graph.put('b.js', 'export const x = 1;\n');
  assert.equal(fingerprint(graph.root), clean, 'restoring the bytes restores the fingerprint');
});

test('an untracked file the checker loads is part of the fingerprint [C7]', () => {
  const graph = fixture();
  const clean = fingerprint(graph.root);
  graph.put('c.js', 'export const y = 1;\n');
  graph.put('a.js', "import './b.js';\nimport './c.js';\n");
  const changed = checkCommandDefinition(graph.root, [], [`${graph.root}/a.js`]);
  assert.ok(changed.some(file => file.path === 'project:c.js'));
  assert.notEqual(JSON.stringify(changed), clean);
});

test('the git index of the checkout Pullboard runs from names its clean files by blob id, and a change there moves the fingerprint [C7]', () => {
  const tool = fixture();
  const project = fixtureCommittedGraph('definition-project-');
  project.put('README.md', 'project\n');
  project.commit();
  const walk = () => checkCommandDefinition(project.root, [], [`${tool.root}/a.js`], { tool: tool.root });
  const clean = walk();
  const oid = name => execFileSync('git', ['rev-parse', `HEAD:${name}`], { cwd: tool.root, encoding: 'utf8' }).trim();
  const digests = Object.fromEntries(clean.filter(file => !file.path.startsWith('project:')).map(file => [file.path.split('/').pop(), file.digest]));
  assert.equal(digests['a.js'], `git:${oid('a.js')}`);
  assert.equal(digests['b.js'], `git:${oid('b.js')}`);
  assert.ok(definitionUnchanged(project.root, clean, [], []), 'an unchanged tool checkout still matches');
  tool.put('b.js', 'export const x = 2;\n');
  assert.equal(definitionUnchanged(project.root, clean, [], []), false, 'a dirty tool file is seen through its index');
  assert.notEqual(JSON.stringify(walk()), JSON.stringify(clean));
  tool.put('b.js', 'export const x = 1;\n');
  assert.equal(JSON.stringify(walk()), JSON.stringify(clean), 'restoring the bytes restores the fingerprint');
});

test('import edges are saved by blob id in the git directory for the next command [C7]', () => {
  const graph = fixture();
  const clean = fingerprint(graph.root);
  const dir = join(graph.root, '.git', 'pullboard');
  const saved = readdirSync(dir).filter(name => /^import-edges-[0-9a-f]+\.json$/u.test(name));
  assert.equal(saved.length, 1);
  const edges = JSON.parse(readFileSync(join(dir, saved[0]), 'utf8'));
  const oid = execFileSync('git', ['rev-parse', 'HEAD:a.js'], { cwd: graph.root, encoding: 'utf8' }).trim();
  const key = Object.keys(edges).find(name => name.startsWith(`git:${oid}:`));
  assert.deepEqual(edges[key], { k: 'js', local: ['./b.js'] });
  assert.equal(fingerprint(graph.root), clean, 'a walk reading saved edges gives the same fingerprint');
});

test('the bounded look-back before each literal reads every Pullboard source the same as the whole prefix [C7]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--', 'apps/*.js', 'packages/*.js', 'bin/*.js'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  assert.ok(files.length > 500, 'the walk covers the repository');
  for (const file of files) {
    let source;
    try { source = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    // Strict mode only adds checks on the whole code, never on a literal's look-back, so one mode covers the window.
    assert.deepEqual(scanImports(source, true), scanImports(source, true, Infinity), file);
  }
});
