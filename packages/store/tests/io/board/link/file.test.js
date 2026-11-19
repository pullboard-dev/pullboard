/** @pullboard-test-input source-cell packages/store */
/** A folder transport carries sealed board-link envelopes between two boards on one machine [E32,H16,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardLinkEnvelope } from '../../../../src/io/board/link/envelope.js';
import { createBoardLinkFileTransport } from '../../../../src/io/board/link/file.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';

const SOURCE = 'a'.repeat(32);
const DESTINATION = 'b'.repeat(32);

/** One hand-built envelope: routing fields and canonical base64url sealed bytes, with no board behind it. */
function handBuilt(position, correlationId, byte) {
  return boardLinkEnvelope({ version: 1, linkId: 'hand-link', generation: 1, sourceBoardId: SOURCE,
    destinationBoardId: DESTINATION, position, correlationId, sealed: Buffer.alloc(64, byte).toString('base64url') });
}

test('store.io-board-link-file.read-returns-sent-envelope: clause 1: a sent envelope is read back byte for byte by the destination board [E32,H16]', async () => {
  const folder = privateFixtureFiles('pullboard-link-file-').root;
  const sender = createBoardLinkFileTransport(folder, { board: SOURCE });
  const receiver = createBoardLinkFileTransport(folder, { board: DESTINATION });
  const envelope = handBuilt(10, 'state-10', 7);
  const receipt = await sender.send(envelope);
  const { deliveries } = await receiver.read();
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].envelope, envelope);
  assert.equal(deliveries[0].envelope.sealed, envelope.sealed, 'the sealed bytes are identical');
  assert.deepEqual(deliveries[0].receipt, receipt);
  assert.deepEqual(await sender.send(deliveries[0].envelope), receipt, 'a retry returns the first receipt');
  assert.equal((await receiver.read()).deliveries.length, 1, 'a retry appends nothing');
  assert.equal((await receiver.read(1)).deliveries.length, 0, 'reading after a delivery ID skips it');
});
