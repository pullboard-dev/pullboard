/** A queued move's review paths read as a nested path tree that names the same literal paths, and the stored move is left as it was (GitHub #35) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathTree } from '../../src/logic/path-tree.js';
import { treePaths } from '../../src/logic/path-tree.js';
import { treeView } from '../../src/logic/path-tree.js';

const PREFIX = 'packages/example/src/features/review/validation/literal-paths';
/** The six repeated-prefix paths of the GitHub #35 example. */
const SIX = ['acceptance.js', 'candidate.js', 'coverage.js', 'freshness.js', 'replay.js', 'validation.js'].map(name => `${PREFIX}/${name}`);
const SHA = 'a'.repeat(40);

test('outbox.path-tree.round-trips-exact-paths: clause 1: treePaths(pathTree(paths)) returns exactly the same sorted literal path set, with a path that is also a folder kept under a "" key, no glob characters added [C7]', () => {
  const tree = pathTree(SIX);
  assert.deepEqual(tree, { packages: { example: { src: { features: { review: { validation: { 'literal-paths': {
    'acceptance.js': null, 'candidate.js': null, 'coverage.js': null, 'freshness.js': null, 'replay.js': null, 'validation.js': null } } } } } } } },
  'the GitHub #35 example nests each folder once, with null leaves');
  assert.deepEqual(treePaths(tree), SIX, 'the tree names exactly the six paths');
  // A cumulative diff can hold a file that was later replaced by a folder of the same name.
  const mixed = ['README.md', 'docs', 'docs/a.md', 'docs/deep/b.md', 'docs/deep', 'z'].sort();
  const both = pathTree(mixed);
  assert.deepEqual(both.docs, { '': null, 'a.md': null, deep: { '': null, 'b.md': null } }, 'a path that is also a folder keeps a "" key');
  assert.deepEqual(treePaths(both), mixed, 'the mixed set round-trips exactly');
  assert.deepEqual(pathTree([...mixed].reverse()), both, 'input order does not change the tree');
  assert.deepEqual(treePaths(pathTree([])), [], 'an empty set stays empty');
  assert.doesNotMatch(JSON.stringify(both), /[*?[\]]/u, 'no glob characters are written');
});

test('outbox.path-tree.stored-move-unchanged: clause 2: treeView(move) leaves the move it read deep-equal to before, its review.paths array included, so the stored relay format is unchanged [C7]', () => {
  const move = { id: 'move-1', operation: 'verify', actor: 'seat-a', args: [7, { verdict: 'accept', review: { commit: SHA, head: SHA, trunk: SHA, paths: [...SIX] } }] };
  const before = structuredClone(move);
  const view = treeView(move);
  assert.deepEqual(move, before, 'the move it read is unchanged');
  assert.ok(Array.isArray(move.args[1].review.paths), 'the stored move keeps its paths array');
  assert.deepEqual(view.args[1].review, { commit: SHA, head: SHA, trunk: SHA, pathTree: pathTree(SIX) }, 'the view holds pathTree in place of paths');
  assert.deepEqual(treePaths(view.args[1].review.pathTree), move.args[1].review.paths, 'the view names the same paths');
  const plain = { id: 'move-2', operation: 'claim', args: [7] };
  assert.deepEqual(treeView(plain), plain, 'a move with no review paths reads the same');
});

test('outbox.path-tree.repeated-prefix-smaller: clause 3: for the six repeated-prefix paths of GitHub #35 the tree JSON is fewer bytes than the array JSON [C7]', (t) => {
  const array = Buffer.byteLength(JSON.stringify(SIX));
  const tree = Buffer.byteLength(JSON.stringify(pathTree(SIX)));
  t.diagnostic(`array ${array} bytes, tree ${tree} bytes`);
  assert.ok(tree < array, `tree ${tree} bytes is fewer than array ${array} bytes`);
});
