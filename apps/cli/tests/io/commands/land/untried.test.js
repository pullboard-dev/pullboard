/** A blocked landing batch sends its items behind untried accepted work, and the next run starts at once [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingTurns } from '../../../../../../packages/landing/index.js';
import { landingRetryAt } from '../../../../src/io/commands/land.js';
import { untriedAfter } from '../../../../src/io/commands/land.js';
import { LANDING_NEXT_BATCH_MS } from '../../../../src/io/commands/land.js';
import { LANDING_RETRY_MS } from '../../../../src/io/commands/land.js';

/** A verified, unmerged item at a commit. */
function verified(id, commit = `c${id}`, extra = {}) {
  return { item_id: id, item_commit: commit, item_status: 'verified', item_merged_commit: null, item_hold_at: null, ...extra };
}

/** A blocked batch of items, refused with a reason that names no failing test. */
function blocked(id, items) {
  return { id, state: 'blocked', items: items.map(([item, commit]) => ({ id: item, commit })), refusal: { code: 'LAND_DIAGNOSTIC', message: 'the no-culprit gate did not identify a failing test file' } };
}

test('clause 1: an item whose latest batch ended blocked with no named test goes behind untried accepted items [C7]', () => {
  const pending = [verified(3478), verified(3687), verified(3862)];
  const batches = [blocked('a', [[3478, 'c3478']]), blocked('b', [[3687, 'c3687']])];
  const turns = landingTurns(batches, new Map(), pending);
  assert.equal(turns.has(3862), false, 'the untried item has no turn, so it sorts first');
  assert.ok(turns.get(3478) < turns.get(3687), 'the least recently blocked item goes next');
  // A block of an older commit is not the resubmitted item's.
  assert.equal(landingTurns([blocked('c', [[3862, 'old']])], new Map(), pending).has(3862), false);
  // Recorded failures keep their own turns and come first among the tried.
  const failed = new Map([[3687, 1]]);
  const mixed = landingTurns(batches, failed, pending);
  assert.equal(mixed.get(3687), 1);
  assert.ok(mixed.get(3478) > 1);
});

test('clause 2: a run that ends blocked while untried verified work waits starts the next run within seconds, not after a back-off [C7]', () => {
  const now = Date.parse('2026-11-09T07:03:30.000Z');
  const batch = blocked('b', [[3687, 'c3687']]);
  const items = [verified(3687), verified(3862)];
  assert.equal(untriedAfter(items, batch), true);
  assert.equal(untriedAfter([verified(3687)], batch), false, 'only the blocked item waits: no hot retry');
  assert.equal(untriedAfter([verified(3687), verified(3862, 'c3862', { item_hold_at: '2026-11-09T07:00:00.000Z' })], batch), false, 'a held item is not untried work');
  assert.equal(untriedAfter(items, { ...batch, state: 'landed' }), false);
  const result = { batch, landed: [], conflicts: [], culprits: [], reopened: 0, waiting: true, untried: true, retryMs: LANDING_RETRY_MS };
  assert.equal(landingRetryAt(result, now), new Date(now + LANDING_NEXT_BATCH_MS).toISOString());
  assert.equal(landingRetryAt({ ...result, untried: false }, now), new Date(now + LANDING_RETRY_MS).toISOString(), 'a lone blocked item keeps the retry interval');
});
