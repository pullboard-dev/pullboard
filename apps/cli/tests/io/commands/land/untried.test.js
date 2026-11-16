/** A blocked landing batch sends its items behind untried accepted work, and the next run starts at once [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingTurns } from '../../../../../../packages/landing/index.js';

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
