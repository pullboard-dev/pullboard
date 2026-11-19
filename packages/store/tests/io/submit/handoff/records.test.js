/** A claimed item's sharded gate that settled unknown (main receipt missing) stays unsettled until the hold ends; red and review are settled [#11711,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/dispatch.js';
import { GATE_SETTLE_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { gateShardsUnsettled } from '../../../../src/io/submit/handoff/records.js';

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
