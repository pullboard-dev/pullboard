/** A submission whose queued gate has no terminal result is neither offered nor reservable for review [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../fixtures/next.js';
import { next } from '../../fixtures/next.js';
import * as store from '../../../../store/index.js';
import { recordSubmitHandoff } from '../../../../jobs/index.js';

/** Write the gate job's record for the item's submitted head, as the queue does at each state change. */
function gate(box, id, state, { receipt = state === 'green' } = {}) {
  const item = store.getItem(box.board, id);
  const agentId = box.seats.builder.id;
  recordSubmitHandoff(box.board.db, id, { version: 1, id: 'job-3737', agentId,
    commit: item.item_commit, executionCommit: item.item_commit, executionTree: item.item_tree, digest: item.item_frozen_digest, state });
  // The production gate writes this captured submit receipt before it completes the hand-off as green.
  if (receipt && !store.proofReceipts(box.board, id).some(row => row.id === 'receipt-3737')) {
    store.logEvent(box.board, agentId, 'proof-run', id, { engine: 0, receipt: { id: 'receipt-3737', kind: 'submit',
      commit: item.item_commit, tree: item.item_tree, seat: agentId, frozenDigest: item.item_frozen_digest, sourceClean: true } });
  }
}

/** One submitted item with its gate running, and the reviewer seat that did not build it. */
function running(t) {
  const box = fixture(t, { reviewers: true });
  box.as('outside');
  const id = box.add('Submission whose gate is still running');
  box.submit(id);
  gate(box, id, 'running');
  return { box, id, reviewer: box.seats.outside };
}

test('moves.record-gate-run.next-verify-skips-an-item-while-its: clause 1: next --verify skips an item while its gate runs and offers it once the gate receipt exists [C7,V4]', async t => {
  const { box, id } = running(t);
  const waiting = await next(box, { verify: true, wait: 0 });
  assert.notEqual(waiting.item?.item_id, id, JSON.stringify(waiting));
  assert.match((waiting.reasons ?? []).join('\n'), /GATE_PENDING/u, 'the skipped review names why');
  gate(box, id, 'green');
  const offered = await next(box, { verify: true, wait: 0 });
  assert.equal(offered.item.item_id, id, 'the finished gate makes it reviewable');
});

test('moves.record-gate-run.a-direct-reserve-of-an-item-whose: clause 1: a direct reserve of an item whose gate has no result is refused with the reason, then succeeds [C7,V4]', async t => {
  const { box, id, reviewer } = running(t);
  await assert.rejects(next(box, { verify: true, verifyId: String(id) }), { code: 'GATE_PENDING' });
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'nothing was reserved');
  gate(box, id, 'green');
  await next(box, { verify: true, verifyId: String(id) });
  assert.equal(store.getItem(box.board, id).item_review_by, reviewer.id);
});

test('moves.record-gate-run.a-reject-finding-no-gate-receipt-is: clause 2: a reject finding no gate receipt is refused and never recorded toward the send-back hold [C7,V4]', async t => {
  const { box, id, reviewer } = running(t);
  gate(box, id, 'green');
  await next(box, { verify: true, verifyId: String(id) });
  gate(box, id, 'running');
  const item = store.getItem(box.board, id);
  assert.throws(() => store.verify(box.board, id, { agentId: reviewer.id, decision: 'REJECT', reason: 'INSUFFICIENT_EVIDENCE',
    note: 'queuedSubmit incomplete, no proof receipts', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' }),
  { code: 'GATE_PENDING' });
  assert.equal(store.getItem(box.board, id).item_status, 'submitted');
  assert.equal(store.getItem(box.board, id).item_verdict ?? null, null);
  const rejects = box.board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='reject'").get(id).n;
  assert.equal(rejects, 0);
});

test('moves.record-gate-run.an-incomplete-hand-off-with-no-proof-receipt: clause 1: an incomplete hand-off with no proof receipt is neither offered, reserved nor given a verdict [C7,V4]', async t => {
  const { box, id, reviewer } = running(t);
  gate(box, id, 'incomplete');
  const offered = await next(box, { verify: true, wait: 0 });
  assert.notEqual(offered.item?.item_id, id, 'not offered');
  assert.match((offered.reasons ?? []).join('\n'), /GATE_PENDING/u);
  await assert.rejects(next(box, { verify: true, verifyId: String(id) }), { code: 'GATE_PENDING' }, 'not reservable');
  const item = store.getItem(box.board, id);
  assert.throws(() => store.verify(box.board, id, { agentId: reviewer.id, decision: 'REJECT', reason: 'INSUFFICIENT_EVIDENCE',
    note: 'queuedSubmit incomplete, no proof receipts', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' }),
  { code: 'GATE_PENDING' }, 'no verdict');
  assert.equal(box.board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='reject'").get(id).n, 0);
});

test('moves.record-gate-run.a-green-hand-off-with-no-captured-receipt: clause 2: a green hand-off with no captured receipt is still refused, and is offered once the receipt exists [C7,V4]', async t => {
  const { box, id, reviewer } = running(t);
  gate(box, id, 'green', { receipt: false });
  await assert.rejects(next(box, { verify: true, verifyId: String(id) }), { code: 'GATE_PENDING' });
  gate(box, id, 'green');
  await next(box, { verify: true, verifyId: String(id) });
  assert.equal(store.getItem(box.board, id).item_review_by, reviewer.id, 'offered because a real receipt exists');
});
