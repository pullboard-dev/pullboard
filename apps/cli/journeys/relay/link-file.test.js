/** A replayed delivery position between two real signed boards is refused over the file transport as on the relay [E32,H16,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { generateBoardKey } from '../../../../packages/kernel/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { signedBoard } from '../../tests/fixtures/board/link.js';
import { consent } from '../../tests/fixtures/board/link.js';

test('cli.journeys-relay-link-file.replayed-position-refused: clause 2: a replayed delivery position is refused as receiveBoardState refuses it on the relay [E32,H16]', async (t) => {
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
  const sender = store.createBoardLinkFileTransport(folder, { board: child.reference.boardId });
  const receiver = store.createBoardLinkFileTransport(folder, { board: parent.reference.boardId });
  await store.deliverBoardState(child.board, context(10, 'state-10'), { authority, capability, transport: sender });
  await store.deliverBoardState(child.board, context(9, 'stale-9'), { authority, capability, transport: sender });
  const { deliveries } = await receiver.read();
  assert.equal(deliveries.length, 2);
  await store.receiveBoardState(parent.board, deliveries[0], { authority, capability });
  await assert.rejects(store.receiveBoardState(parent.board, deliveries[1], { authority, capability }), (error) => error.code === 'BOARD_LINK_REPLAY');
});
