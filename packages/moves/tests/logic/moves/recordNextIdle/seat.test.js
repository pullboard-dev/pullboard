/** A seat whose submit gate is running is offered the two-minute review through next and next --take [C7,#3077]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { take } from '../../../fixtures/next.js';

/** Claim an item as the actor seat and start its submit handoff, as `submit --no-next` leaves it. */
function submitting(box, title) {
  const seat = box.seats.actor;
  const id = box.add(title);
  box.claim(id, seat);
  const head = box.git('rev-parse', 'HEAD');
  const tree = box.git('rev-parse', `${head}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: head, commit: head, tree, executionCommit: head, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  return id;
}

test('clause 2: a pending handoff counts as free for the two-minute oldest-review offer [C7,#3077]', async t => {
  const box = fixture(t);
  submitting(box, 'Submit handoff frees the seat for review');
  const waiting = box.add('Review waiting two minutes');
  box.submit(waiting);
  const build = box.add('Another open build', { brief: 'Files: web/other.js\nTest: the unrelated build stays open.' });
  box.advance(2 * 60_000);
  const offered = await next(box);
  assert.equal(offered.item.item_id, waiting);
  assert.equal(offered.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
});

test('next --take reserves the two-minute review while its only claim is a pending handoff (clauses 1 and 2) [C7,#3077]', async t => {
  const box = fixture(t);
  const held = submitting(box, 'Only claim is gating');
  const before = store.getItem(box.board, held);
  const waiting = box.add('Review at the inclusive age boundary');
  box.submit(waiting);
  const build = box.add('Unclaimed build', { brief: 'Files: web/other.js\nTest: remains unclaimed.' });
  box.advance(2 * 60_000);
  const offered = await take(box);
  assert.equal(offered.item.item_id, waiting);
  assert.equal(offered.review, true);
  assert.equal(store.getItem(box.board, waiting).item_review_by, box.seats.actor.id);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  assert.equal(store.getItem(box.board, held).item_owner, before.item_owner);
  assert.equal(store.getItem(box.board, held).item_lease_until, before.item_lease_until);
  assert.ok(store.pendingSubmitHandoff(box.board, store.getItem(box.board, held)));
});
