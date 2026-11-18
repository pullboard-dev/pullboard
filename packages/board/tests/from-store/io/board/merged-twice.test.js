/** `merged` on an item that already has a merged commit refuses or writes nothing, so a landing is recorded once [B2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { submitFixture } from '../../../../../store/tests/fixtures/submit.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

/** A verified item on a real Git project and SQLite board. */
function verifiedItem(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const builder = cellSeat(board, { lane: 'web', path: `${project.dir}/builder` }).id;
  const id = cellItem(board, { lane: 'web', title: 'Merged twice', criterion: 'Tracked work', specIds: ['G1'] }).item_id;
  const commit = String(id).repeat(40).slice(0, 40);
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
  submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
  store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
  return { board, id };
}

/** How many merged events the item has. */
const mergedEvents = (board, id) => store.events(board, { itemId: id }).filter(e => e.event_kind === 'merged').length;

test('board.merged-twice.merged-already-merged-item-refuses-already: merged on an already merged item refuses ALREADY_MERGED for another commit [B2]', (t) => {
  const { board, id } = verifiedItem(t);
  store.merged(board, id, { agentId: 'coordinator', commit: 'a'.repeat(40) });
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: 'b'.repeat(40) }), (error) => {
    assert.equal(error.code, 'ALREADY_MERGED');
    return true;
  });
  assert.equal(store.getItem(board, id).item_merged_commit, 'a'.repeat(40));
  assert.equal(mergedEvents(board, id), 1);
});

test('board.merged-twice.merged-naming-the-same-commit-again: merged naming the same commit again writes nothing [B2]', (t) => {
  const { board, id } = verifiedItem(t);
  store.merged(board, id, { agentId: 'coordinator', commit: 'a'.repeat(40) });
  store.merged(board, id, { agentId: 'coordinator', commit: 'a'.repeat(40) });
  assert.equal(mergedEvents(board, id), 1);
});
