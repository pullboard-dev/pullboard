/** @pullboard-test-input packages/store/src/logic/red/return.js */
/** An item whose gate job has not settled keeps its claim through seat silence; one whose gate settled, or passed its deadline, does not [C7,#8342,#10931]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../index.js';
import { itemWorkInFlight } from '../index.js';
import { fixture } from './fixtures/dispatch.js';

/** Put one gate or shard job row on the board as the jobs cell writes it, created at the board clock's now unless `at` is given. */
function job(board, { id, kind, item, step, at = board.clock.now().getTime() }) {
  board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(id, kind, item, step, at, at);
}

/** Record the note the board writes on a sharded gate job once its combined result applied. */
function settle(board, gate) {
  board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', '{\"outcome\":\"review\"}', ?)")
    .run(gate, board.clock.now().getTime());
}

/** A claimed item whose newest gate job is done and which has shards in the given steps. */
function claimedWithShards(t, steps) {
  const box = fixture(t);
  const id = box.add('Item in the gate');
  box.claim(id);
  const at = box.clock.now().getTime();
  job(box.board, { id: 'gate:1', kind: 'gate', item: id, step: 'done', at });
  steps.forEach((step, index) => job(box.board, { id: `gate:1:shard:${index + 1}`, kind: 'gate-shard', item: id, step, at: at + 1 + index }));
  return { box, id };
}

test('store.gate-shard-claim.an-item-whose-gate-job-is: clause 1: an item whose gate job is still running proof shards is not released when its seat heartbeat lapses [C7,#8342]', t => {
  const { box, id } = claimedWithShards(t, ['done', 'claimed', 'offered']);
  box.advance(10 * 60_000);
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), true);
});

test('store.gate-shard-claim.an-item-whose-gate-job-has: clause 2: an item whose gate job has ended is released as before when its seat heartbeat lapses [C7,#8342]', t => {
  const { box, id } = claimedWithShards(t, ['done', 'done']);
  settle(box.board, 'gate:1');
  box.advance(10 * 60_000);
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), false);
  const stale = claimedWithShards(t, ['offered']);
  job(stale.box.board, { id: 'gate:2', kind: 'gate', item: stale.id, step: 'done', at: stale.box.clock.now().getTime() + 100 });
  assert.equal(itemWorkInFlight(stale.box.board, getItem(stale.box.board, stale.id)), false, 'shards of an older gate job do not count');
});

test('store.gate-shard-claim.unsettled-gate-holds: clause 1: a claimed item whose newest gate job is done, with every proof shard done but no settled note, is work in flight, as one with shards still offered or claimed is [C7,#10931]', t => {
  const done = claimedWithShards(t, Array(32).fill('done'));
  done.box.advance(3 * 60_000);
  assert.equal(itemWorkInFlight(done.box.board, getItem(done.box.board, done.id)), true, 'all 32 shards done, result not applied: the gate is still the board\'s work');
  const open = claimedWithShards(t, ['done', 'offered', 'claimed']);
  open.box.advance(3 * 60_000);
  assert.equal(itemWorkInFlight(open.box.board, getItem(open.box.board, open.id)), true, 'open shards hold the claim');
});

test('store.gate-shard-claim.settled-or-deadline-frees: clause 2: once the gate job notes shards.settled, or 2 hours after the gate job was created, the gate no longer holds the claim, and an older gate\'s shards never do [C7,#10931]', t => {
  const settled = claimedWithShards(t, Array(32).fill('done'));
  settle(settled.box.board, 'gate:1');
  assert.equal(itemWorkInFlight(settled.box.board, getItem(settled.box.board, settled.id)), false, 'a settled gate holds nothing');
  const late = claimedWithShards(t, ['done', 'done']);
  late.box.advance(2 * 3_600_000 - 60_000);
  assert.equal(itemWorkInFlight(late.box.board, getItem(late.box.board, late.id)), true, 'inside the deadline an unsettled gate still holds');
  late.box.advance(60_000);
  assert.equal(itemWorkInFlight(late.box.board, getItem(late.box.board, late.id)), false, 'at the 2 hour deadline a gate with no live shard job no longer holds');
  const older = claimedWithShards(t, Array(4).fill('done'));
  job(older.box.board, { id: 'gate:2', kind: 'gate', item: older.id, step: 'done', at: older.box.clock.now().getTime() + 100 });
  assert.equal(itemWorkInFlight(older.box.board, getItem(older.box.board, older.id)), false, 'an older gate job\'s unsettled shards do not count');
});

test('store.gate-shard-claim.live-shard-holds-past-deadline: a gate with a live shard job still holds the claim past the 2 hour deadline [C7,#11923]', t => {
  const live = claimedWithShards(t, ['done', 'offered']);
  live.box.advance(2 * 3_600_000 + 60_000);
  assert.equal(itemWorkInFlight(live.box.board, getItem(live.box.board, live.id)), true, 'an offered shard holds the claim past 2 hours');
  live.box.advance(3 * 3_600_000);
  assert.equal(itemWorkInFlight(live.box.board, getItem(live.box.board, live.id)), true, 'a live shard job holds with no time bound');
});
