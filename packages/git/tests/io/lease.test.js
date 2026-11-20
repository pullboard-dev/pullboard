/** The queued item lease keeper renews a reviewer's own lapsed reservation and refuses every real takeover [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueuedItemLease } from '../../src/io/lease.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** A review item reserved to `rev-1`, with the same board functions the caller injects. */
function fixture(over = {}) {
  const item = { item_id: 7, item_status: 'submitted', item_review_by: 'rev-1', item_review_until: iso(NOW - 60000), item_frozen_digest: 'd1', item_commit: 'c1', item_owner: 'b-1', item_lease_until: iso(NOW - 60000), item_lane: 'core', ...over };
  const moves = [];
  const ctx = { io: {}, info: { root: '/none' }, clock: { now: () => new Date(NOW) }, config: { reviewLeaseMs: 1800000, leaseMs: 900000, verify: { policy: 'p', family: 'f' } } };
  const deps = {
    getItem: () => item,
    withBoard: async (_ctx, fn) => await fn({}),
    ordered: async (_ctx, _board, name, args) => { moves.push({ name, args }); return { item_review_until: iso(NOW + 1800000), leaseUntil: iso(NOW + 900000) }; },
    claimFreezer: () => () => ({}),
    gateWaitReporter: () => () => {},
  };
  return { item, moves, ctx, deps };
}

const poll = (f, kind, initial) => createQueuedItemLease(f.ctx, initial, kind === 'review' ? 'rev-1' : 'b-1', kind, null, f.deps);

test('git.io-lease.lapsed-own-review-renews: clause 1: a review keeper polled after its own reservation lapsed re-reserves with reserveReview and returns the new lease [C7]', async () => {
  const f = fixture();
  const keeper = poll(f, 'review', { ...f.item });
  const out = await keeper({ admitted: false });
  assert.equal(f.moves.length, 1);
  assert.equal(f.moves[0].name, 'reserveReview');
  assert.deepEqual(f.moves[0].args[0], 7);
  assert.equal(f.moves[0].args[1].agentId, 'rev-1');
  assert.equal(out.leaseUntil, iso(NOW + 1800000));
});

test('git.io-lease.taken-over-refused: clause 2: a changed reviewer, status, commit or digest, and a lapsed build claim, each still throw ITEM_LEASE_LOST [C7]', async () => {
  const cases = [
    ['reviewer changed', 'review', { item_review_by: 'rev-2' }],
    ['status moved', 'review', { item_status: 'accepted' }],
    ['commit changed', 'review', { item_commit: 'c2' }],
    ['digest changed', 'review', { item_frozen_digest: 'd2' }],
    ['lapsed build claim', 'build', { item_status: 'claimed' }],
  ];
  for (const [name, kind, over] of cases) {
    const f = fixture(kind === 'build' ? { item_status: 'claimed' } : {});
    const initial = { ...f.item };
    Object.assign(f.item, over);
    const keeper = poll(f, kind, initial);
    await assert.rejects(() => keeper({ admitted: false }), (e) => e.code === 'ITEM_LEASE_LOST' || /ITEM_LEASE_LOST/.test(String(e.message) + String(e.code)), name);
    assert.equal(f.moves.length, 0, name);
  }
});
