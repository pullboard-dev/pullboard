/** @pullboard-test-input packages/landing/src/io/land/squash.js */
/** squashOnto lands an item tip as one single-parent commit and keeps the branch under refs/pullboard/items [C7,#9218]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { tryGit } from '../../../../git/index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { squashOnto } from '../../../src/io/land/squash.js';
import { itemKeepRef } from '../../../src/io/land/squash.js';

const git = (root, ...args) => runFixtureGit(args, { cwd: root }).trim();

/** A repo with a two-commit item branch off the first base, and trunk moved on by a commit of its own. */
function history(t, { conflict = false } = {}) {
  const repo = cellRepo(t, { real: true });
  const root = repo.root;
  const first = repo.commit;
  repo.put('item-a.txt', 'a\n');
  repo.commitAll();
  repo.put(conflict ? 'shared.txt' : 'item-b.txt', 'from the item\n');
  const tip = repo.commitAll();
  git(root, 'checkout', '-q', '--detach', first);
  repo.put(conflict ? 'shared.txt' : 'trunk.txt', 'from trunk\n');
  const base = repo.commitAll();
  return { root, base, tip };
}

test('clause 1: squashOnto writes one commit whose only parent is base, with the merge-tree tree and the given message [C7,#9218]', t => {
  const { root, base, tip } = history(t);
  const message = 'feat(landing): squash\n\nPullboard-Item: #9218';
  const result = squashOnto(root, { base, tip, message, item: 9218 });
  assert.equal(git(root, 'rev-list', '--parents', '-n1', result.commit), `${result.commit} ${base}`);
  assert.equal(git(root, 'rev-parse', `${result.commit}^{tree}`), git(root, 'merge-tree', '--write-tree', base, tip).split('\n')[0]);
  assert.equal(git(root, 'log', '-1', '--format=%B', result.commit), message);
});

test('clause 2: refs/pullboard/items/<item> points at tip and a conflicting tip returns the conflict, not a commit [C7,#9218]', t => {
  const { root, base, tip } = history(t);
  squashOnto(root, { base, tip, message: 'feat: squash', item: 9218 });
  assert.equal(git(root, 'rev-parse', itemKeepRef(9218)), tip);

  const clash = history(t, { conflict: true });
  const refused = squashOnto(clash.root, { base: clash.base, tip: clash.tip, message: 'feat: squash', item: 9219 });
  assert.equal(refused.conflict, true);
  assert.equal(refused.commit, undefined);
  assert.deepEqual(refused.files, ['shared.txt']);
  assert.notEqual(tryGit(clash.root, ['rev-parse', '--verify', '-q', itemKeepRef(9219)]).status, 0);
});
