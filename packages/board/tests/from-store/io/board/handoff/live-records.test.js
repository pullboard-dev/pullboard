/** The item lister reads hand-off records only for items still in play, so a board of thousands of closed items stays fast [I6]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../store/index.js';
import { cellBoard } from '../../../../fixtures/cell-board.js';
import { recordSubmitHandoff } from '../../../../../../jobs/index.js';

// fixture-subject: addItem (a store unit test of the lister over seeded items; the board is opened through the kit)

/** Run a raw status write under the move token the board's status trigger requires. */
function asMove(board, sql, ...args) {
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try { board.db.prepare(sql).run(...args); } finally { board.db.exec('DELETE FROM temp.moving'); }
}

/** Add an item with a red gate job record, then close it when asked. */
function itemWithGate(board, title, status) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title });
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  recordSubmitHandoff(board.db, id, { version: 1, id: `job-${id}`, agentId: 'core-1', commit: 'c'.repeat(40), digest: 'digest', state: 'red',
    error: { code: 'GATE_RED', message: 'The proof is red.', next: 'Fix it.' } });
  if (status === 'verified') {
    // The board's verified rule needs an ACCEPT on the frozen criterion by a verifier other than the builder, at the item's commit.
    board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      VALUES (?, 'web-6', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, 'digest', ?, '2026-10-06T00:00:00Z')`).run(id, 'a'.repeat(40), 'a'.repeat(40));
  }
  if (status) asMove(board, "UPDATE item SET item_status = ?, item_verified_by = 'web-6', item_withdrawn_reason = 'fixture', item_built_by = 'web-5', item_commit = ? WHERE item_id = ?", status, 'a'.repeat(40), id);
  return id;
}

test('clause 2: the item lister reads hand-off records only for items still in play, and every stage is unchanged [I6]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date('2026-11-14T08:00:00.000Z') });
  const live = itemWithGate(board, 'In play', null);
  const closed = itemWithGate(board, 'Verified', 'verified');
  const withdrawn = itemWithGate(board, 'Withdrawn', 'withdrawn');
  assert.deepEqual([...store.handoffRecords(board.db).keys()].sort(), [live, closed, withdrawn].sort(), 'the full read still sees every job');
  assert.deepEqual([...store.handoffRecords(board.db, { live: true }).keys()], [live], 'the live read skips closed items');
  const listed = new Map(store.listItems(board, { all: true }).map(item => [item.item_id, item.item_stage]));
  assert.equal(listed.get(live), 'back with builder');
  assert.equal(listed.get(closed), 'accepted');
  assert.equal(listed.get(withdrawn), 'withdrawn');
});
