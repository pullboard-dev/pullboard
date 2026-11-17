/** The shared receipt predicate: a screen receipt counts only when green, trusted, leased, at the item's commit and frozen digest, and on the current base [M1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptCounts } from '../../../index.js';

const ITEM = { commit: 'c1', digest: 'd1' };
const GOOD = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b1' };
const counts = (receipt, base = 'b1') => receiptCounts(receipt, { kind: 'screen', item: ITEM, base });

test('moves.screen-receipt.a-screen-receipt-counts-only-when-it: clause 2: a screen receipt counts only when it is green, trusted, at the item\'s commit and on the current base [M1]', () => {
  assert.equal(counts(GOOD), true);
  assert.equal(counts({ ...GOOD, green: false }), false, 'a red screen');
  assert.equal(counts({ ...GOOD, trusted: false }), false, 'a screen from untrusted code');
  assert.equal(counts({ ...GOOD, commit: 'c0' }), false, 'a screen of an older commit');
  assert.equal(counts(GOOD, 'b2'), false, 'a screen from an older base');
  assert.equal(counts({ ...GOOD, leased: false }), false, 'a screen posted without the live lease');
  assert.equal(counts({ ...GOOD, digest: 'd0' }), false, 'a screen under another frozen bar');
  assert.equal(counts({ ...GOOD, kind: 'gate' }), false, 'another kind of receipt');
  assert.equal(counts(null), false, 'no receipt');
  assert.equal(counts(GOOD, null), false, 'no known base');
});

test('moves.screen-receipt.item-8864-another-kind-of-receipt-is-judged: #8864: another kind of receipt is judged without a base [M1]', () => {
  const gate = { ...GOOD, kind: 'gate', base: undefined };
  assert.equal(receiptCounts(gate, { kind: 'gate', item: ITEM, base: 'b9' }), true);
  assert.equal(receiptCounts({ ...gate, green: false }, { kind: 'gate', item: ITEM }), false);
});
