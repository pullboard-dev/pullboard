/** @pullboard-test-input packages/store/src/logic/board/stale/apply.js */
/** A seat that submits and goes quiet keeps its claim while its sharded gate has not settled; once the gate settles the seat-gone rule takes it [C7,#10931]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../../../../index.js';
import { maintainStaleState } from '../../../../index.js';
import { staleStateLimits } from '../../../../index.js';
import { fixture } from '../../../fixtures/dispatch.js';

const MINUTE = 60_000;

/**
 * A builder claims an item and submits: its gate job passed its checks and offered 32 shard jobs. The board then runs
 * with moves.live.reclaim on, as it does by default. `pass` hands one seat-gone row for the quiet builder to the
 * production maintenance write, as the claim-path sweep does.
 */
function submitted(t) {
  const box = fixture(t);
  box.board.movesLive = { reclaim: true };
  const id = box.add('Item in a sharded gate');
  box.claim(id);
  const builder = box.seats.builder.id;
  const claimEvent = box.board.db.prepare("SELECT event_id, event_at FROM event WHERE item_id=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(id);
  const at = box.clock.now().getTime();
  const job = (jobId, kind, step) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(jobId, kind, id, step, at, at);
  const gate = `gate:${id}:0123456789ab:fixture`;
  job(gate, 'gate', 'done');
  for (let index = 1; index <= 32; index += 1) job(`${gate}:shard:${index}`, 'gate-shard', 'offered');
  const heartbeatAt = box.clock.now().toISOString();
  const pass = () => {
    const observedAt = box.clock.now().toISOString();
    const previous = Number(box.board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lapsed_claim_scan_cursor'").get()?.meta_value ?? 0);
    return maintainStaleState(box.board, { agentId: box.seats.actor.id, claimsOnly: true, snapshot: {
      observedAt, observedRevision: box.board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id, holds: [], reviews: [],
      limits: staleStateLimits({}, { dependency: true }), claimScan: { previous, next: previous + 1 },
      claims: [{ id, actor: builder, idle: 'seat-gone', claimEventId: claimEvent.event_id, claimAt: claimEvent.event_at,
        deadSeat: { observedAt, quietMs: 120_000, heartbeatAt, worktreeMissing: false } }] } });
  };
  const shardsDone = () => box.board.db.prepare("UPDATE job SET job_step='done' WHERE job_kind='gate-shard' AND job_item=?").run(id);
  const settle = (outcome = 'review') => box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
    .run(gate, JSON.stringify({ outcome }), box.clock.now().getTime());
  const releases = () => box.board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.event_detail));
  return { box, id, builder, pass, shardsDone, settle, releases };
}

test('store.stale-apply.silent-seat-keeps-gate-claim: clause 3: a seat silent for 3 minutes keeps its claim while its 32 gate shards are pending and while they are done but unsettled; once the gate settles the same pass releases it as seat-gone [C7,#10931]', t => {
  const f = submitted(t);
  f.box.advance(3 * MINUTE);
  assert.throws(f.pass, error => error.code === 'STALE_STATE_CHANGED', 'pending shards: the seat-gone row is refused');
  assert.equal(getItem(f.box.board, f.id).item_status, 'claimed');
  assert.equal(getItem(f.box.board, f.id).item_owner, f.builder, 'the quiet seat still holds the item its gate result applies to');
  assert.deepEqual(f.releases(), [], 'a refused pass writes no release');
  f.shardsDone();
  f.box.advance(MINUTE);
  assert.throws(f.pass, error => error.code === 'STALE_STATE_CHANGED', 'every shard done, result not applied: still the board\'s work');
  assert.equal(getItem(f.box.board, f.id).item_owner, f.builder);
  assert.deepEqual(f.releases(), []);
  f.settle();
  const result = f.pass();
  assert.deepEqual(result.claims, [f.id], 'a settled gate leaves the quiet seat to the seat-gone rule');
  assert.equal(getItem(f.box.board, f.id).item_status, 'open');
  assert.equal(f.releases().length, 1);
  assert.equal(f.releases()[0].idleClaim.kind, 'seat-gone');
});

test('store.stale-apply.silent-seat-keeps-unknown-gate-claim: clause 3: a seat silent for 3 minutes whose gate settled unknown keeps its claim, with no release event [C7,#11711]', t => {
  const f = submitted(t);
  f.shardsDone();
  f.settle('unknown');
  f.box.advance(3 * MINUTE);
  assert.throws(f.pass, error => error.code === 'STALE_STATE_CHANGED', 'unknown outcome: main receipt still to settle it, so the seat-gone row is refused');
  assert.equal(getItem(f.box.board, f.id).item_status, 'claimed');
  assert.equal(getItem(f.box.board, f.id).item_owner, f.builder);
  assert.deepEqual(f.releases(), [], 'a refused pass writes no release');
});
