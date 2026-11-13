/** A checker's fingerprint comes from the git index: the same tree gives the same one, and a changed or new file moves it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../apps/cli/tests/fixtures/testkit.js';
import { checkCommandDefinition } from '../../src/io/check/definition.js';

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
