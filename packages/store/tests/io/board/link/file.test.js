/** @pullboard-test-input source-cell packages/store */
/** A folder transport carries sealed board-link envelopes between two boards on one machine [E32,H16,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { createBoardLinkFileTransport } from '../../../../src/io/board/link/file.js';
import { signedBoard } from '../../../../../../apps/cli/tests/fixtures/board/link.js';
import { consent } from '../../../../../../apps/cli/tests/fixtures/board/link.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { generateBoardKey } from '../../../../../kernel/src/logic/seal.js';

/** Two linked boards, a per-link capability and a delivery folder, all private to the test. */
async function pair(t) {
  const parent = signedBoard(t, 'parent');
  const child = signedBoard(t, 'child');
  const authority = store.createSshBoardLinkAuthority([parent, child]);
  const record = await consent(store, authority, parent, child, 'file-link');
  await store.applyBoardLink(parent.board, record, authority);
  await store.applyBoardLink(child.board, record, authority);
  const capability = store.createBoardLinkCapability(record, await generateBoardKey());
  const folder = privateFixtureFiles('pullboard-link-file-').root;
  const context = (position, correlationId) => ({ linkId: record.linkId, generation: 1, sourceBoardId: child.reference.boardId,
    destinationBoardId: parent.reference.boardId, position, correlationId,
    rows: [{ board: child.reference.boardId, id: 1, state: 'claimed' }] });
  return { parent, child, authority, capability, folder, context };
}

test('store.io-board-link-file.read-returns-sent-envelope: clause 1: a sent envelope is read back byte for byte by the destination board [E32,H16]', async (t) => {
  const { parent, child, capability, folder, context } = await pair(t);
  const sender = createBoardLinkFileTransport(folder, { board: child.reference.boardId });
  const receiver = createBoardLinkFileTransport(folder, { board: parent.reference.boardId });
  const envelope = await capability.seal('state-10', store.boardStateAnnouncement(child.board, context(10, 'state-10')));
  const receipt = await sender.send(envelope);
  const { deliveries } = await receiver.read();
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].envelope, envelope);
  assert.equal(deliveries[0].envelope.sealed, envelope.sealed, 'the sealed bytes are identical');
  assert.deepEqual(deliveries[0].receipt, receipt);
  assert.deepEqual(await sender.send(deliveries[0].envelope), receipt, 'a retry returns the first receipt');
  assert.equal((await receiver.read()).deliveries.length, 1, 'a retry appends nothing');
  assert.equal((await receiver.read(1)).deliveries.length, 0, 'reading after a delivery ID skips it');
  assert.deepEqual((await capability.open(deliveries[0].envelope)).rows, [{ board: child.reference.boardId, id: 1, state: 'claimed' }]);
});

test('store.io-board-link-file.replayed-position-refused: clause 2: a replayed delivery position is refused as receiveBoardState refuses it on the relay [E32,H16]', async (t) => {
  const { parent, child, authority, capability, folder, context } = await pair(t);
  const sender = createBoardLinkFileTransport(folder, { board: child.reference.boardId });
  const receiver = createBoardLinkFileTransport(folder, { board: parent.reference.boardId });
  await store.deliverBoardState(child.board, context(10, 'state-10'), { authority, capability, transport: sender });
  await store.deliverBoardState(child.board, context(9, 'stale-9'), { authority, capability, transport: sender });
  const { deliveries } = await receiver.read();
  assert.equal(deliveries.length, 2);
  await store.receiveBoardState(parent.board, deliveries[0], { authority, capability });
  await assert.rejects(store.receiveBoardState(parent.board, deliveries[1], { authority, capability }), (error) => error.code === 'BOARD_LINK_REPLAY');
});
