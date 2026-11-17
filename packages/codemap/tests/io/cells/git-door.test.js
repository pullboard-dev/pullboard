/** @pullboard-test-input source-cell codemap */
/** @pullboard-world-pin clause 2 reads the inventory cache source to prove it imports Git from the door. */
/** The codemap door exports the Git reader the inventory cache uses [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { cellGit } from '../../../index.js';
import { git } from '../../../src/io/cells/git.js';

test('codemap.git-door.the-door-exports-the-git: clause 1: the door exports the Git reader and it returns the same rev-parse HEAD output in a temp repository [C7]', () => {
  const repo = fixtureCommittedGraph('git-door-');
  repo.put('a.txt', 'one\n');
  const commit = repo.commit();
  assert.equal(typeof cellGit, 'function');
  const head = cellGit(repo.root, ['rev-parse', 'HEAD']);
  assert.equal(head.trim(), commit);
  assert.equal(head, git(repo.root, ['rev-parse', 'HEAD']));
});

test('codemap.git-door.the-inventory-cache-imports-its: clause 1: the inventory cache imports its Git reader from the door, not by relative path [C7]', () => {
  const cache = readFileSync(fileURLToPath(new URL('../../../src/io/cells/scripts/cache.js', import.meta.url)), 'utf8');
  assert.match(cache, /import \{ cellGit as git \} from '\.\.\/\.\.\/\.\.\/\.\.\/index\.js';/u);
  assert.doesNotMatch(cache, /from '\.\.\/git\.js'/u);
});
