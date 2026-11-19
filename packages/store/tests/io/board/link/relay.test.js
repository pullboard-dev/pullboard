/** A received board state records when this board received it, taken from the board clock [E32,H16,#11044]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardId } from '../../../../index.js';
import { closeBoard } from '../../../../index.js';
import { createBoardLinkCapability } from '../../../../index.js';
import { applyBoardLink } from '../../../../index.js';
import { approveBoardLink } from '../../../../index.js';
import { receiveBoardState } from '../../../../index.js';
import { readReceivedBoardState } from '../../../../index.js';
import { generateBoardKey } from '../../../../../kernel/index.js';
import { openKitBoard } from '../../../fixtures/cell.js';

const CHILD = 'c'.repeat(32);
const RECEIVED = '2026-11-19T08:00:00.000Z';

/** A signer authority that accepts every approval: the signature check is not what this test proves. */
const authority = {
  async sign(board, _text, { by }) { return { boardId: board, by, on: RECEIVED, signature: 'fixture' }; },
  async verify() { return true; },
};

test('store.io-board-link-relay.state-records-received-at: clause 1: after receiveBoardState installs a state, readReceivedBoardState returns it with receivedAt from the board clock, and a record stored before this change reads with no receivedAt [E32,H16,#11044]', async t => {
  const board = openKitBoard(':memory:', { now: () => new Date(RECEIVED) });
  t.after(() => closeBoard(board));
  const parent = { boardId: boardId(board), organization: 'fixture', handle: 'parent' };
  const child = { boardId: CHILD, organization: 'fixture', handle: 'child' };
  let record = { version: 1, linkId: 'received-at', parent, child, generation: 1, disclosure: 'states', approvals: [], revocation: null };
  record = await approveBoardLink(record, parent.boardId, authority, { by: 'parent' });
  record = await approveBoardLink(record, child.boardId, authority, { by: 'child' });
  await applyBoardLink(board, record, authority);
  const capability = createBoardLinkCapability(record, await generateBoardKey());
  const announcement = { version: 1, linkId: 'received-at', generation: 1, sourceBoardId: CHILD, destinationBoardId: parent.boardId,
    position: 3, disclosure: 'states', rows: [{ board: CHILD, id: 8, state: 'claimed' }] };
  const envelope = await capability.seal('state-3', announcement);
  const { createHash } = await import('node:crypto');
  const receipt = { version: 1, deliveryId: 1, sourceBoardId: CHILD, destinationBoardId: parent.boardId, linkId: 'received-at', generation: 1,
    correlationId: 'state-3', position: 3, digest: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'), at: RECEIVED };
  await receiveBoardState(board, { envelope, receipt }, { authority, capability });
  const key = { linkId: 'received-at', generation: 1, sourceBoardId: CHILD };
  assert.deepEqual(readReceivedBoardState(board, key), { ...announcement, receivedAt: RECEIVED });
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)')
    .run(`board_link_state:old-link:1:${CHILD}`, JSON.stringify(announcement));
  const old = readReceivedBoardState(board, { linkId: 'old-link', generation: 1, sourceBoardId: CHILD });
  assert.equal(old.position, 3);
  assert.equal('receivedAt' in old, false);
});
