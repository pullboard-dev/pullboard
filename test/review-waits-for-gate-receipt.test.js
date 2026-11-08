/** A submission whose queued gate has no terminal result is neither offered nor reservable for review [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, cli } from './next-take-fixture.js';
import * as store from '../packages/store/index.js';
import { recordSubmitHandoff } from '../packages/jobs/index.js';

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
async function running(t) {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const id = box.add('Submission whose gate is still running');
  box.submit(id);
  gate(box, id, 'running');
  return { box, id, reviewer: box.seats.outside };
}

test('clause 1: next --verify skips an item while its gate runs and offers it once the gate receipt exists [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  const waiting = await cli(box, reviewer.path, ['next', '--verify', '--wait', '0']);
  assert.notEqual(waiting.document?.item?.item_id, id, waiting.out + waiting.err);
  assert.match(waiting.out, /GATE_PENDING/u, 'the skipped review names why');
  gate(box, id, 'green');
  const offered = await cli(box, reviewer.path, ['next', '--verify', '--wait', '0']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, id, 'the finished gate makes it reviewable');
});

test('clause 1: a direct reserve of an item whose gate has no result is refused with the reason, then succeeds [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  const refused = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out + refused.err, /GATE_PENDING/u);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'nothing was reserved');
  gate(box, id, 'green');
  const reserved = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(store.getItem(box.board, id).item_review_by, reviewer.id);
});

test('clause 2: a reject finding no gate receipt is refused and never recorded toward the send-back hold [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  gate(box, id, 'green');
  const reserved = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
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

test('clause 1: an incomplete hand-off with no proof receipt is neither offered, reserved nor given a verdict [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  gate(box, id, 'incomplete');
  const offered = await cli(box, reviewer.path, ['next', '--verify', '--wait', '0']);
  assert.notEqual(offered.document?.item?.item_id, id, 'not offered');
  assert.match(offered.out, /GATE_PENDING/u);
  const reserved = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.notEqual(reserved.code, 0, reserved.out);
  assert.match(reserved.out + reserved.err, /GATE_PENDING/u, 'not reservable');
  const item = store.getItem(box.board, id);
  assert.throws(() => store.verify(box.board, id, { agentId: reviewer.id, decision: 'REJECT', reason: 'INSUFFICIENT_EVIDENCE',
    note: 'queuedSubmit incomplete, no proof receipts', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' }),
  { code: 'GATE_PENDING' }, 'no verdict');
  assert.equal(box.board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='reject'").get(id).n, 0);
});

test('clause 2: a green hand-off with no captured receipt is still refused, and is offered once the receipt exists [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  gate(box, id, 'green', { receipt: false });
  const refused = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out + refused.err, /GATE_PENDING/u);
  gate(box, id, 'green');
  const reserved = await cli(box, reviewer.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(store.getItem(box.board, id).item_review_by, reviewer.id, 'offered because a real receipt exists');
});
