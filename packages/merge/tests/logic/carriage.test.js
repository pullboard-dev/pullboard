/** @pullboard-world-pin builds real git repositories and worktrees in a private root; the board reads are explicit ports. */
/** The main-moved conflict shout judges the item's own branch, never the seat checkout branch [N2,B3,#3820]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mainMovedWarnings } from '../../index.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';

/**
 * Build a seat checkout on its own conflicting branch, two per-item folders on item branches, and a moved main.
 * Item 7's branch changes a file main did not touch; item 8's branch changes the file main changed.
 *
 * @param {import('node:test').TestContext} t - Test context that removes the fixture.
 * @returns {{seat: string, trunk: string, reads: object, unrelated: string, conflicting: string}} The fixture.
 */
function movedMain(t) {
  const tree = privateFixtureFiles('pb-main-move-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  const seat = join(tree.root, 'seat');
  /** Run git in a checkout of the fixture with a fixed identity. */
  const git = (cwd, ...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd });
  tree.write('seat/shared.txt', 'base\n');
  tree.write('seat/other.txt', 'base\n');
  git(seat, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(seat, 'add', '-A');
  git(seat, 'commit', '-q', '-m', 'base');
  for (const id of [7, 8]) git(seat, 'worktree', 'add', '-q', '-b', `item-${id}`, `${seat}-item-${id}`, 'main');
  // Git created these item-branch files, so the fixture capability does not own them; edit them in place.
  writeFileSync(join(tree.root, 'seat-item-7/other.txt'), 'item seven\n');
  git(`${seat}-item-7`, 'commit', '-q', '-am', 'item seven');
  writeFileSync(join(tree.root, 'seat-item-8/shared.txt'), 'item eight\n');
  git(`${seat}-item-8`, 'commit', '-q', '-am', 'item eight');
  tree.write('seat/shared.txt', 'trunk\n');
  git(seat, 'commit', '-q', '-am', 'main moves');
  const trunk = git(seat, 'rev-parse', 'HEAD');
  git(seat, 'checkout', '-q', '-b', 'seat-own', 'main~1');
  tree.write('seat/shared.txt', 'seat own\n');
  git(seat, 'commit', '-q', '-am', 'the seat checkout branch conflicts with the new main');
  const claimed = id => ({ item_id: id, item_status: 'claimed', item_owner: 'seat-a', item_merged_commit: null, item_commit: null });
  const reads = { listAgents: () => [{ agent_id: 'seat-a', agent_path: seat }], listItems: () => [claimed(7), claimed(8)] };
  return { seat, trunk, reads, unrelated: git(`${seat}-item-7`, 'rev-parse', 'HEAD'), conflicting: git(`${seat}-item-8`, 'rev-parse', 'HEAD') };
}

test('clause 1: an item whose own branch merges cleanly gets no conflict warning although its seat checkout branch conflicts [N2,B3,#3820]', t => {
  const { seat, trunk, reads } = movedMain(t);
  const warnings = mainMovedWarnings({ root: seat, board: {}, trunk }, reads);
  assert.deepEqual(warnings.filter(warning => warning.item === 7), []);
});

test('clause 2: an item whose own branch really conflicts with the new main gets one warning naming the conflicting file [N2,B3,#3820]', t => {
  const { seat, trunk, reads, conflicting } = movedMain(t);
  const warnings = mainMovedWarnings({ root: seat, board: {}, trunk }, reads);
  assert.deepEqual(warnings, [{ item: 8, head: conflicting, trunk, files: ['shared.txt'] }]);
});
