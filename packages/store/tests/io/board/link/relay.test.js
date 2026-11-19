/** A failed board-link delivery is re-sent from its stored envelope, once, and a stored receipt is never sent again [E32,H16]. */
// fixture-subject: addItem (a store unit test of resendPendingBoardStates over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardLinkDeliveryReceipt } from '../../../../index.js';
import { boardLinkEnvelope } from '../../../../index.js';
import { boardLinkEnvelopeDigest } from '../../../../index.js';
import { closeBoard } from '../../../../index.js';
import { resendPendingBoardStates } from '../../../../index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell.js';

const SOURCE = 'a'.repeat(32);
const DESTINATION = 'b'.repeat(32);

/** One hand-built envelope between two distinct boards, with canonical sealed bytes. */
function envelopeFor(correlationId, byte) {
  return boardLinkEnvelope({ version: 1, linkId: 'hand-link', generation: 1, sourceBoardId: SOURCE, destinationBoardId: DESTINATION,
    position: 1, correlationId, sealed: Buffer.alloc(64, byte).toString('base64url') });
}

/** The receipt a transport answers for one envelope. */
function receiptFor(envelope, deliveryId) {
  return boardLinkDeliveryReceipt({ version: 1, deliveryId, sourceBoardId: SOURCE, destinationBoardId: DESTINATION, linkId: envelope.linkId, generation: 1,
    correlationId: envelope.correlationId, position: envelope.position, digest: boardLinkEnvelopeDigest(envelope), at: '2026-11-18T00:00:00.000Z' }, envelope);
}

/** A board with one queued delivery per correlation ID; a receipt is stored only for those named in `delivered`. */
function queued(t, correlations, delivered = []) {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  const envelopes = {};
  for (const [index, correlationId] of correlations.entries()) {
    const envelope = envelopes[correlationId] = envelopeFor(correlationId, index + 1);
    const receipt = delivered.includes(correlationId) ? receiptFor(envelope, 100 + index) : null;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`board_link_outbox:${DESTINATION}:${correlationId}`, JSON.stringify({ contentDigest: `digest-${correlationId}`, envelope, receipt }));
  }
  return { board, envelopes };
}

const receiptOf = (board, correlationId) => JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`board_link_outbox:${DESTINATION}:${correlationId}`).meta_value).receipt;
const delivered = board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'board_link_delivered'").get().n;

test('store.io-board-link-relay.resend-sends-stored-envelope-once: clause 1: resendPendingBoardStates sends the stored envelope of each outbox entry that has no receipt, once, and stores the receipt and a board_link_delivered event [E32,H16]', async (t) => {
  const { board, envelopes } = queued(t, ['state-1', 'state-2']);
  const sends = [];
  const transport = { board: SOURCE, async send(envelope) { sends.push(envelope.correlationId); return receiptFor(envelope, sends.length); } };
  const result = await resendPendingBoardStates(board, { transport });
  assert.deepEqual(sends, ['state-1', 'state-2']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.sent.map(receipt => receipt.correlationId), ['state-1', 'state-2']);
  assert.deepEqual(receiptOf(board, 'state-1'), receiptFor(envelopes['state-1'], 1));
  assert.equal(delivered(board), 2);
});

test('store.io-board-link-relay.resend-skips-receipted-entry: clause 2: an outbox entry that already holds a receipt is not sent again [E32,H16]', async (t) => {
  const { board } = queued(t, ['state-1', 'state-2'], ['state-1']);
  const sends = [];
  const transport = { board: SOURCE, async send(envelope) { sends.push(envelope.correlationId); return receiptFor(envelope, 7); } };
  await resendPendingBoardStates(board, { transport });
  assert.deepEqual(sends, ['state-2']);
  assert.equal(receiptOf(board, 'state-1').deliveryId, 100);
  assert.equal(delivered(board), 1);
});

test('store.io-board-link-relay.resend-keeps-failed-entry-pending: clause 3: when transport.send throws, the entry keeps no receipt and the call returns it as failed, so a later call sends it again [E32,H16]', async (t) => {
  const { board } = queued(t, ['state-1']);
  const down = { board: SOURCE, async send() { throw new Error('link down'); } };
  const first = await resendPendingBoardStates(board, { transport: down });
  assert.deepEqual(first.sent, []);
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0].correlationId, 'state-1');
  assert.equal(first.failed[0].error, 'link down');
  assert.equal(receiptOf(board, 'state-1'), null);
  assert.equal(delivered(board), 0);
  const sends = [];
  const up = { board: SOURCE, async send(envelope) { sends.push(envelope.correlationId); return receiptFor(envelope, 1); } };
  const second = await resendPendingBoardStates(board, { transport: up });
  assert.deepEqual(sends, ['state-1']);
  assert.equal(second.sent.length, 1);
  assert.equal(delivered(board), 1);
});
