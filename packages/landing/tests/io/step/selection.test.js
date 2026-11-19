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

test('landing.selection.a-verified-item-whose-only-unmerged: clause 1: a verified item whose only unmerged dependency is withdrawn is selected and the batch entry records it [test] [C7]', t => {
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

const OWN = 'a'.repeat(32), CHILD = 'b'.repeat(32);

/** Write a signed-shape link to repo `child` and the state its board last announced for #7 into the real board's metadata. */
function announce(board, state, version) {
  const approval = (boardId) => ({ version: 1, type: 'approve', boardId, signature: 'sig' });
  const link = { version: 1, linkId: 'link-1', parent: { boardId: OWN, organization: 'org', handle: 'parent' }, child: { boardId: CHILD, organization: 'org', handle: 'child' },
    generation: 1, disclosure: 'states', approvals: [approval(OWN), approval(CHILD)], revocation: null };
  const put = board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  put.run('board_id', OWN);
  put.run('board_link:0', JSON.stringify(link));
  put.run(`board_link_state:link-1:1:${CHILD}`, JSON.stringify({ version, linkId: 'link-1', generation: 1, sourceBoardId: CHILD, destinationBoardId: OWN, position: 1, disclosure: 'states', rows: [{ board: CHILD, id: 7, state }] }));
}

test('landing.selection.foreign-wait-needs-landed: clause 1: a verified item with a foreign wait whose state is not landed is blocked WAITS_ON_ITEM naming repo#id, and lands once the state is landed [test] [XB1,E32]', t => {
  const { root, board, base } = scratch(t);
  const listed = [{ item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_after: 'child#7', item_hold_at: null }];
  announce(board, 'verified', 2);
  const waiting = candidates(board, root, base, 8, { listItems: () => listed });
  assert.deepEqual(waiting.ready, []);
  assert.equal(waiting.blocked[0].code, 'WAITS_ON_ITEM');
  assert.match(waiting.blocked[0].message, /child#7/u);
  announce(board, 'landed', 2);
  const landed = candidates(board, root, base, 8, { listItems: () => listed });
  assert.deepEqual(landed.blocked, []);
  assert.deepEqual(landed.ready.map(item => item.item_id), [2822]);
  announce(board, 'verified', 1);
  assert.deepEqual(candidates(board, root, base, 8, { listItems: () => listed }).ready.map(item => item.item_id), [2822], 'a version 1 announcement falls back to verified');
});

test('landing.selection.local-waits-unchanged: clause 2: an item with only local waits behaves as before [test] [XB1,E32]', t => {
  const { root, board, base } = scratch(t);
  const listed = [
    { item_id: 2658, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null },
    { item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_after: '2658', item_hold_at: null },
  ];
  const { blocked } = candidates(board, root, base, 8, { listItems: () => listed });
  assert.deepEqual(blocked.map(entry => [entry.id, entry.code, entry.message, entry.items]), [[2822, 'WAITS_ON_ITEM', 'waits on unmerged item(s) #2658', [2658]]]);
});
