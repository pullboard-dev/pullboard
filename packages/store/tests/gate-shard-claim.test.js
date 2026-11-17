/** @pullboard-test-input packages/store/src/logic/red/return.js */
/** An item whose gate job still has live proof shards keeps its claim through seat silence; one whose gate ended does not [C7,#8342]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../index.js';
import { itemWorkInFlight } from '../index.js';
import { fixture } from './fixtures/dispatch.js';

/** Put one gate or shard job row on the board as the jobs cell writes it. */
function job(board, { id, kind, item, step, at }) {
  board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(id, kind, item, step, at, at);
}

/** A claimed item whose newest gate job is done and which has shards in the given steps. */
function claimedWithShards(t, steps) {
  const box = fixture(t);
  const id = box.add('Item in the gate');
  box.claim(id);
  job(box.board, { id: 'gate:1', kind: 'gate', item: id, step: 'done', at: 1000 });
  steps.forEach((step, index) => job(box.board, { id: `gate:1:shard:${index + 1}`, kind: 'gate-shard', item: id, step, at: 1001 + index }));
  return { box, id };
}

test('store.gate-shard-claim.an-item-whose-gate-job-is: clause 1: an item whose gate job is still running proof shards is not released when its seat heartbeat lapses [C7,#8342]', t => {
  const { box, id } = claimedWithShards(t, ['done', 'claimed', 'offered']);
  box.advance(10 * 60_000);
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), true);
});

test('store.gate-shard-claim.an-item-whose-gate-job-has: clause 2: an item whose gate job has ended is released as before when its seat heartbeat lapses [C7,#8342]', t => {
  const { box, id } = claimedWithShards(t, ['done', 'done']);
  box.advance(10 * 60_000);
  assert.equal(itemWorkInFlight(box.board, getItem(box.board, id)), false);
  const stale = claimedWithShards(t, ['offered']);
  job(stale.box.board, { id: 'gate:2', kind: 'gate', item: stale.id, step: 'done', at: 5000 });
  assert.equal(itemWorkInFlight(stale.box.board, getItem(stale.box.board, stale.id)), false, 'shards of an older gate job do not count');
});
