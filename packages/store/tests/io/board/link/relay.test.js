/** A failed board-link delivery is re-sent from its stored envelope once, and a received board state records when this board received it [E32,H16,#11044]. */
// fixture-subject: addItem (a store unit test of resendPendingBoardStates over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardLinkDeliveryReceipt } from '../../../../index.js';
import { boardLinkEnvelope } from '../../../../index.js';
import { boardLinkEnvelopeDigest } from '../../../../index.js';
import { closeBoard } from '../../../../index.js';
import { resendPendingBoardStates } from '../../../../index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell.js';
import { boardId } from '../../../../index.js';
import { createBoardLinkCapability } from '../../../../index.js';
import { applyBoardLink } from '../../../../index.js';
import { approveBoardLink } from '../../../../index.js';
import { receiveBoardState } from '../../../../index.js';
import { readReceivedBoardState } from '../../../../index.js';
import { generateBoardKey } from '../../../../../kernel/index.js';
import { openKitBoard } from '../../../fixtures/cell.js';

const SOURCE = 'a'.repeat(32);
const DESTINATION = 'b'.repeat(32);

const CHILD = 'c'.repeat(32);
const RECEIVED = '2026-11-19T08:00:00.000Z';

/** A signer authority that accepts every approval: the signature check is not what this test proves. */
const authority = {
  async sign(board, _text, { by }) { return { boardId: board, by, on: RECEIVED, signature: 'fixture' }; },
  async verify() { return true; },
};

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
