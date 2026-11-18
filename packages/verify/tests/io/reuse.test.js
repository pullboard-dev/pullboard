/** The sealed-move fallback names the policy commit without asking for a frozen check [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sealedFallbackMain } from '../../src/io/reuse.js';

const MAIN = 'm'.repeat(40);
const events = [{ event_id: 1, event_by: 'seat', event_kind: 'submit', event_detail: JSON.stringify({ policyCommit: MAIN }) }];

test('verify.io-reuse.sealed-fallback-no-check: clause 1: sealedFallbackMain returns the submitted policy commit when nothing else decides the verdict, whatever the check [C7]', () => {
  assert.equal(sealedFallbackMain(events, { reused: null, reReview: false, companionDigest: null, effectiveHead: null }), MAIN);
  assert.equal(sealedFallbackMain(events, { reused: { reason: 'none' } }), MAIN, 'a reuse refusal without ids leaves the fallback');
  assert.equal(sealedFallbackMain(events), MAIN, 'no inputs at all still returns it');
});

test('verify.io-reuse.sealed-fallback-guards: clause 2: sealedFallbackMain returns null when reused.ids, reReview, companionDigest or effectiveHead is set, and the policy commit otherwise [C7]', () => {
  assert.equal(sealedFallbackMain(events, { reused: { ids: ['r1'] } }), null);
  assert.equal(sealedFallbackMain(events, { reReview: true }), null);
  assert.equal(sealedFallbackMain(events, { companionDigest: 'd' }), null);
  assert.equal(sealedFallbackMain(events, { effectiveHead: 'h' }), null);
  assert.equal(sealedFallbackMain([], {}), null, 'with no submission there is no policy commit');
  assert.equal(sealedFallbackMain(events, { reused: {}, reReview: false }), MAIN);
  // an item that has a frozen check still gets the submitted policy commit
  {
  const check = 'node --test packages/verify/tests/io/reuse.test.js';
  const withCheck = [{ event_id: 0, event_by: 'coordinator', event_kind: 'check-baseline', event_detail: JSON.stringify({ check }) }, ...events];
  assert.equal(sealedFallbackMain(withCheck, { check }), MAIN);
  assert.equal(sealedFallbackMain(withCheck, { reused: { ids: ['r1'] }, check }), null, 'the guards still win over a check');
  }
});
