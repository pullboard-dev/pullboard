/** @pullboard-test-input source-cell packages/moves */
/** A full-suite receipt for the item's group counts only when green, trusted, leased and current [M2,#9324]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptCounts } from '../../../index.js';

const ITEM = { commit: 'c1', digest: 'd1', group: 'core' };
const GOOD = { kind: 'suite', suite: 'full', group: 'core', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b1' };
const counts = (receipt, base = 'b1', item = ITEM) => receiptCounts(receipt, { kind: 'suite', item, base });

test('moves.suite-receipt.a-green-trusted-leased-full-suite-receipt: clause 1: a green, trusted, leased full-suite receipt for the item\'s group counts at its commit, digest and the current base [M2,#9324]', () => {
  assert.equal(counts(GOOD), true);
});

test('moves.suite-receipt.a-partial-suite-another-group-an-older: clause 2: a partial suite, another group, an older base, a red or an untrusted receipt does not count [M2,#9324]', () => {
  assert.equal(counts({ ...GOOD, suite: 'partial' }), false, 'a partial suite');
  assert.equal(counts({ ...GOOD, suite: undefined }), false, 'a receipt that names no suite');
  assert.equal(counts({ ...GOOD, group: 'view' }), false, 'another group');
  assert.equal(counts({ ...GOOD, group: undefined }), false, 'a receipt naming no group');
  assert.equal(counts(GOOD, 'b2'), false, 'an older base');
  assert.equal(counts(GOOD, null), false, 'no known base');
  assert.equal(counts({ ...GOOD, green: false }), false, 'a red receipt');
  assert.equal(counts({ ...GOOD, trusted: false }), false, 'an untrusted receipt');
  assert.equal(counts({ ...GOOD, leased: false }), false, 'a receipt without the live lease');
  assert.equal(counts({ ...GOOD, commit: 'c0' }), false, 'an older commit');
  assert.equal(counts({ ...GOOD, digest: 'd0' }), false, 'another frozen bar');
  assert.equal(counts({ ...GOOD, kind: 'screen' }), false, 'a screen receipt');
  assert.equal(counts(GOOD, 'b1', { ...ITEM, group: null }), false, 'an item with no group');
  assert.equal(counts(null), false, 'no receipt');
});

test('moves.suite-receipt.the-screen-kind-still-counts-exactly-as: clause 3: the screen kind still counts exactly as before [M2,#9324]', () => {
  const screen = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b1' };
  const screenCounts = (receipt, base = 'b1') => receiptCounts(receipt, { kind: 'screen', item: ITEM, base });
  assert.equal(screenCounts(screen), true, 'a screen needs no suite or group');
  assert.equal(screenCounts(screen, 'b2'), false, 'a screen from an older base');
  assert.equal(screenCounts({ ...screen, green: false }), false);
  assert.equal(receiptCounts({ ...screen, kind: 'gate', base: undefined }, { kind: 'gate', item: ITEM }), true, 'other kinds ignore base');
});
