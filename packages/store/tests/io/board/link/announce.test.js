/** @pullboard-test-input source-cell packages/store */
/** After an item on a linked child board changes state, each parent that waits on it is told through the file transport [E32,B24,#11039]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announceItemState } from '../../../../src/io/board/link/announce.js';
import { applyBoardLink } from '../../../../index.js';
import { approveBoardLink } from '../../../../index.js';
import { boardId } from '../../../../index.js';
import { closeBoard } from '../../../../index.js';
import { createBoardLinkCapability } from '../../../../index.js';
import { createBoardLinkFileTransport } from '../../../../index.js';
import { generateBoardKey } from '../../../../../kernel/index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { cellItem } from '../../../fixtures/cell.js';
import { openKitBoard } from '../../../fixtures/cell.js';

const PARENT = 'b'.repeat(32);
const AT = '2026-11-19T08:00:00.000Z';

/** A signer authority that accepts every approval: the signature check is not what this test proves. */
const authority = {
  async sign(board, _text, { by }) { return { boardId: board, by, on: AT, signature: 'fixture' }; },
  async verify() { return true; },
};

/** A child board with one open item, a signed states link to a parent board, and the file transport folder between them. */
async function linked(t) {
  const board = openKitBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => closeBoard(board));
  const item = cellItem(board, { lane: 'core', title: 'Child work', criterion: '1. It works. [test]' });
  const parent = { boardId: PARENT, organization: 'fixture', handle: 'parent' };
  const child = { boardId: boardId(board), organization: 'fixture', handle: 'kid' };
  let record = { version: 1, linkId: 'announce-link', parent, child, generation: 1, disclosure: 'states', approvals: [], revocation: null };
  record = await approveBoardLink(record, parent.boardId, authority, { by: 'parent' });
  record = await approveBoardLink(record, child.boardId, authority, { by: 'child' });
  await applyBoardLink(board, record, authority);
  const capability = createBoardLinkCapability(record, await generateBoardKey());
  const folder = privateFixtureFiles('pullboard-announce-').root;
  const transport = createBoardLinkFileTransport(folder, { board: child.boardId });
  const parentRow = (id, status, after) => ({ item_id: id, item_status: status, item_after: after });
  return { board, item, record, capability, folder, transport, child, parentRow };
}

test('store.io-board-link-announce.writes-state-for-waiting-parent: clause 1: announceItemState writes a boardStateAnnouncement of the item into the file transport for each parent item that waits on it [E32,B24]', async (t) => {
  const { board, item, record, capability, folder, transport, child, parentRow } = await linked(t);
  const parentItems = [parentRow(40, 'open', [`kid#${item.item_id}`])];
  const result = await announceItemState(board, item.item_id, { links: [{ record, parentItems, authority, capability, transport }] });
  assert.equal(result.sent.length, 1);
  assert.deepEqual(result.failed, []);
  const { deliveries } = await createBoardLinkFileTransport(folder, { board: PARENT }).read();
  assert.equal(deliveries.length, 1);
  const announcement = await capability.open(deliveries[0].envelope);
  assert.deepEqual(announcement.rows, [{ board: child.boardId, id: item.item_id, state: item.item_status }]);
});

test('store.io-board-link-announce.skips-item-no-parent-waits-on: clause 1: an item that no open parent item names writes nothing [E32,B24]', async (t) => {
  const { board, item, record, capability, folder, transport, parentRow } = await linked(t);
  const parentItems = [parentRow(40, 'open', ['kid#999']), parentRow(41, 'verified', [`kid#${item.item_id}`])];
  const result = await announceItemState(board, item.item_id, { links: [{ record, parentItems, authority, capability, transport }] });
  assert.deepEqual(result, { sent: [], failed: [] });
  assert.equal((await createBoardLinkFileTransport(folder, { board: PARENT }).read()).deliveries.length, 0);
});

test('store.io-board-link-announce.failed-delivery-stays-queued: clause 2: when the transport throws, announceItemState returns the failed delivery, the sealed envelope stays queued for resendPendingBoardStates, and the item keeps its state [E32,B24,#11159]', async (t) => {
  const { board, item, record, capability, parentRow } = await linked(t);
  const down = { board: boardId(board), async send() { throw new Error('link down'); } };
  const parentItems = [parentRow(40, 'open', [`kid#${item.item_id}`])];
  const result = await announceItemState(board, item.item_id, { links: [{ record, parentItems, authority, capability, transport: down }] });
  assert.equal(result.sent.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'link down');
  const queued = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB 'board_link_outbox:*'").all();
  assert.equal(queued.length, 1);
  assert.equal(JSON.parse(queued[0].meta_value).receipt, null);
  assert.equal(board.db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(item.item_id).item_status, item.item_status);
});
