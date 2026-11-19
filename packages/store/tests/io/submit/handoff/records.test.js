/** A claimed item's sharded gate that settled unknown (main receipt missing) stays unsettled until the hold ends; red and review are settled [#11711,C7]. The hold counts from the shard offer, not the gate's creation [#11921]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/dispatch.js';
import { GATE_SETTLE_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { gateShardsUnsettled } from '../../../../src/io/submit/handoff/records.js';
import { awaitingGateOrReview } from '../../../../src/io/submit/handoff/records.js';
import { getItem } from '../../../../index.js';

/** A claimed item whose gate job is done, with two shard jobs done; `settle(outcome)` notes the combined result. */
function settledGate(t) {
  const box = fixture(t);
  const id = box.add('Item whose gate settled');
  box.claim(id);
  const at = box.clock.now().getTime();
  const gate = `gate:${id}:0123456789ab:fixture`;
  const job = (jobId, kind) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, 'done', NULL, 0, ?, ?)`).run(jobId, kind, id, at, at);
  job(gate, 'gate');
  job(`${gate}:shard:1`, 'gate-shard');
  job(`${gate}:shard:2`, 'gate-shard');
  const settle = outcome => box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
    .run(gate, JSON.stringify({ outcome }), at);
  return { box, item: { item_id: id }, settle };
}

test('store.submit-handoff-records.unknown-gate-holds-claim: clause 1: an unknown settled gate younger than the hold is unsettled, a red or review one is settled [C7,#11711]', t => {
  const unknown = settledGate(t);
  unknown.settle('unknown');
  assert.equal(gateShardsUnsettled(unknown.box.board, unknown.item), true);
  for (const outcome of ['red', 'review']) {
    const other = settledGate(t);
    other.settle(outcome);
    assert.equal(gateShardsUnsettled(other.box.board, other.item), false, `${outcome} is settled`);
  }
});

test('store.submit-handoff-records.unknown-gate-hold-ends: clause 2: the same unknown gate older than the hold is settled [C7,#11711]', t => {
  const f = settledGate(t);
  f.settle('unknown');
  f.box.advance(GATE_SETTLE_HOLD_MS + 1);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false);
});

/** A claimed item whose gate job was created 3 h ago, queued, and passed its checks 1 h ago, offering two shards that are still open. */
function lateGate(t) {
  const box = fixture(t);
  const id = box.add('Item whose gate queued before its checks');
  box.claim(id);
  const now = box.clock.now().getTime();
  const created = now - 3 * 3_600_000;
  const offered = now - 3_600_000;
  const gate = `gate:${id}:0123456789ab:late`;
  const job = (jobId, kind, step, at, updated) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(jobId, kind, id, step, at, updated);
  job(gate, 'gate', 'done', created, offered);
  job(`${gate}:shard:1`, 'gate-shard', 'offered', offered, offered);
  job(`${gate}:shard:2`, 'gate-shard', 'claimed', offered, offered);
  /** The last shard posts, then the board notes the combined result, as it does when a sharded gate settles. */
  const settle = outcome => {
    box.board.db.prepare("UPDATE job SET job_step = 'done' WHERE job_kind = 'gate-shard' AND job_item = ?").run(id);
    box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
      .run(gate, JSON.stringify({ outcome }), box.clock.now().getTime());
  };
  return { box, item: { item_id: id }, id, settle };
}

test('store.submit-handoff-records.hold-counts-from-shard-offer: clause 1: a gate created 3 h ago that offered its open shards 1 h ago is unsettled, and 2 h after the offer it is settled [C7,#11921]', t => {
  const f = lateGate(t);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), true, 'the hold counts from the shard offer, not the gate creation 3 h ago');
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.id)), true, 'so the claim is the gate\'s wait, not buildable work');
  f.box.advance(GATE_SETTLE_HOLD_MS - 3_600_000 - 1);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), true, 'just inside 2 h after the offer it still holds');
  f.box.advance(1);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false, '2 h after the offer the hold ends');
});

test('store.submit-handoff-records.late-gate-red-settles: clause 2: that late gate, once it notes shards.settled red, is settled and no longer holds the claim [C7,#11921]', t => {
  const f = lateGate(t);
  f.settle('red');
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false);
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.id)), false, 'a settled red returns the claim as rework');
});
