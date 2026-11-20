/** A received child state that goes from verified or landed back to open holds the parent items that wait on it [XB1,#11045]. */
// fixture-subject: addItem (a store unit test of receiveBoardState over a seeded board)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { closeBoard } from '../../../../index.js';
import { boardId } from '../../../../index.js';
import { createBoardLinkCapability } from '../../../../index.js';
import { applyBoardLink } from '../../../../index.js';
import { approveBoardLink } from '../../../../index.js';
import { receiveBoardState } from '../../../../index.js';
import { addItem } from '../../../../index.js';
import { getItem } from '../../../../index.js';
import { generateBoardKey } from '../../../../../kernel/index.js';
import { openKitBoard } from '../../../fixtures/cell.js';

const CHILD = 'c'.repeat(32);
const RECEIVED = '2026-11-19T08:00:00.000Z';

/** A signer authority that accepts every approval: the signature check is not what this test proves. */
const authority = {
  async sign(board, _text, { by }) { return { boardId: board, by, on: RECEIVED, signature: 'fixture' }; },
  async verify() { return true; },
};

/** A parent board linked to a child named `kid`, with a function that receives one child state at the next position. */
async function linked(t) {
  const board = openKitBoard(':memory:', { now: () => new Date(RECEIVED) });
  t.after(() => closeBoard(board));
  const parent = { boardId: boardId(board), organization: 'fixture', handle: 'parent' };
  const child = { boardId: CHILD, organization: 'fixture', handle: 'kid' };
  let record = { version: 1, linkId: 'regress', parent, child, generation: 1, disclosure: 'states', approvals: [], revocation: null };
  record = await approveBoardLink(record, parent.boardId, authority, { by: 'parent' });
  record = await approveBoardLink(record, child.boardId, authority, { by: 'child' });
  await applyBoardLink(board, record, authority);
  const capability = createBoardLinkCapability(record, await generateBoardKey());
  let position = 0;
  const receive = async rows => {
    position += 1;
    const correlationId = `state-${position}`;
    const announcement = { version: 1, linkId: 'regress', generation: 1, sourceBoardId: CHILD, destinationBoardId: parent.boardId,
      position, disclosure: 'states', rows: rows.map(([id, state]) => ({ board: CHILD, id, state })) };
    const envelope = await capability.seal(correlationId, announcement);
    const receipt = { version: 1, deliveryId: position, sourceBoardId: CHILD, destinationBoardId: parent.boardId, linkId: 'regress', generation: 1,
      correlationId, position, digest: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'), at: RECEIVED };
    await receiveBoardState(board, { envelope, receipt }, { authority, capability });
  };
  return { board, receive };
}

/** A parent item that waits on kid#id, set to the given status. */
function waiting(board, id, status, extra = {}) {
  const item = addItem(board, { by: 'coordinator', lane: 'core', title: `waits on kid#${id}`, after: [`kid#${id}`] });
  board.db.prepare('UPDATE item SET item_status=?, item_merged_commit=? WHERE item_id=?').run(status, extra.merged ?? null, item.item_id ?? item);
  return item.item_id ?? item;
}

const events = (board, kind) => board.db.prepare('SELECT event_item, event_detail FROM event WHERE event_kind=? ORDER BY event_id').all(kind);

test('store.io-board-link-regress.reopened-holds-claimed-dependent: clause 1: a received state going from verified or landed back to open holds each claimed dependent with a reason naming repo#id [XB1,#11045]', async t => {
  const { board, receive } = await linked(t);
  const first = waiting(board, 8, 'claimed');
  const second = waiting(board, 9, 'claimed');
  const idle = waiting(board, 5, 'claimed');
  await receive([[8, 'verified'], [9, 'landed'], [5, 'verified']].map(([id, state]) => [id, state]));
  await receive([[8, 'open'], [9, 'open'], [5, 'verified']]);
  assert.match(getItem(board, first).item_hold_reason, /kid#8/u);
  assert.match(getItem(board, second).item_hold_reason, /kid#9/u);
  assert.equal(getItem(board, idle).item_hold_reason, null);
});

test('store.io-board-link-regress.landed-dependent-gets-notice: clause 2: a dependent that already landed gets a notice fact and no hold [XB1,#11045]', async t => {
  const { board, receive } = await linked(t);
  const done = waiting(board, 8, 'verified', { merged: 'f'.repeat(40) });
  await receive([[8, 'verified']]);
  await receive([[8, 'open']]);
  assert.equal(getItem(board, done).item_hold_reason, null);
  const notices = events(board, 'board_link_regress_notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].event_item, done);
  assert.match(notices[0].event_detail, /kid#8/u);
});

test('store.io-board-link-regress.first-state-and-other-moves-hold-nothing: clause 1: a first received state, and a state that only moves open to claimed, hold no dependent [XB1,#11045]', async t => {
  const { board, receive } = await linked(t);
  const item = waiting(board, 8, 'claimed');
  await receive([[8, 'open']]);
  await receive([[8, 'claimed']]);
  assert.equal(getItem(board, item).item_hold_reason, null);
  assert.deepEqual(events(board, 'board_link_regress_notice'), []);
});
