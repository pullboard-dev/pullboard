/** A submission whose queued gate has no terminal result is neither offered nor reservable for review [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, cli } from './next-take-fixture.js';
import * as store from '../packages/store/index.js';
import { recordSubmitHandoff } from '../packages/jobs/index.js';

/** Write the gate job's record for the item's submitted head, as the queue does at each state change. */
function gate(box, id, state) {
  const item = store.getItem(box.board, id);
  recordSubmitHandoff(box.board.db, id, { version: 1, id: 'job-3737', agentId: box.seats.builder.id,
    commit: item.item_commit, digest: item.item_frozen_digest, state });
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

test('next --verify skips an item while its gate runs and offers it once the gate receipt exists [C7,V4]', async t => {
  const { box, id, reviewer } = await running(t);
  const waiting = await cli(box, reviewer.path, ['next', '--verify', '--wait', '0']);
  assert.notEqual(waiting.document?.item?.item_id, id, waiting.out + waiting.err);
  assert.match(waiting.out, /GATE_PENDING/u, 'the skipped review names why');
  gate(box, id, 'green');
  const offered = await cli(box, reviewer.path, ['next', '--verify', '--wait', '0']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, id, 'the finished gate makes it reviewable');
});

test('a direct reserve of an item whose gate has no result is refused with the reason, then succeeds [C7,V4]', async t => {
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

test('a reject finding no gate receipt is refused and never recorded toward the send-back hold [C7,V4]', async t => {
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
