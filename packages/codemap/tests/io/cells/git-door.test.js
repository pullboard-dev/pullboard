/** @pullboard-test-input source-cell codemap */
/** The codemap door exports the Git reader the inventory cache uses [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
