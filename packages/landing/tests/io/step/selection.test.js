/** Landing selection treats a withdrawn dependency as met and records that in the batch entry [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { fixtureOpenBoard } from '../../../../board/tests/fixtures/board.js';
import * as store from '../../../../store/index.js';
import { candidates } from '../../../src/io/step/selection.js';
import { landingEntry } from '../../../src/io/step/selection.js';

/** A real scratch repo with one commit, and a real private board file. */
function scratch(t) {
  const fixture = privateFixtureFiles('pullboard-step-selection-'), root = fixture.root;
  const vcs = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  vcs('init', '-q', '-b', 'main');
  fixture.write('a.txt', 'base\n');
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'base');
  const boards = privateFixtureFiles('pullboard-step-selection-board-');
  const board = fixtureOpenBoard({ boardFile: join(boards.root, 'board.sqlite') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); rmSync(boards.root, { recursive: true, force: true }); });
  return { root, board, base: vcs('rev-parse', 'HEAD') };
}

test('clause 1: a verified item whose only unmerged dependency is withdrawn is selected and the batch entry records it [test] [C7]', t => {
  const { root, board, base } = scratch(t);
  const listed = [
    { item_id: 2658, item_status: 'withdrawn', item_merged_commit: null, item_commit: base },
    { item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_after: '2658', item_hold_at: null },
  ];
  const { ready, blocked } = candidates(board, root, base, 8, { listItems: () => listed });
  assert.deepEqual(blocked, []);
  assert.deepEqual(ready.map(item => item.item_id), [2822]);
  assert.deepEqual(landingEntry(ready[0]).withdrawnDependencies, [2658], 'the batch entry names the withdrawn dependency');
  assert.equal('withdrawnDependencies' in landingEntry({ item_id: 1, item_commit: 'a', item_landing_commit: 'a' }), false, 'an item with no withdrawn dependency records none');
});
