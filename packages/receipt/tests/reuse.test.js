/** The receipt cell keys receipts by candidate and base and says when a composition can reuse one [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptKey } from '../index.js';
import { reusable } from '../index.js';
import { receiptByKey } from '../index.js';

const receipt = { candidate: 'c1', base: 'b1', verdict: 'green' };

test('receipt.key.stable: [C7] receiptKey is stable per (candidate, base) and refuses a missing id', () => {
  assert.equal(receiptKey('c1', 'b1'), receiptKey('c1', 'b1'));
  assert.notEqual(receiptKey('c1', 'b1'), receiptKey('b1', 'c1'));
  assert.throws(() => receiptKey('c1', ''), { code: 'RECEIPT_KEY' });
});

test('receipt.reuse.composition: [C7] reusable says when a landing composition can reuse a submit receipt', () => {
  assert.deepEqual(reusable(receipt, { candidate: 'c1', base: 'b1' }), { reuse: true, code: null });
  assert.equal(reusable(receipt, { candidate: 'c1', base: 'b2' }).code, 'BASE_MOVED');
  assert.equal(reusable(receipt, { candidate: 'c2', base: 'b1' }).code, 'CANDIDATE_CHANGED');
  assert.equal(reusable({ ...receipt, verdict: 'red' }, { candidate: 'c1', base: 'b1' }).code, 'NOT_GREEN');
  assert.equal(reusable(null, { candidate: 'c1', base: 'b1' }).code, 'NO_RECEIPT');
});

test('receipt.review.by-key: [C7] review reads a receipt by key', () => {
  const other = { candidate: 'c2', base: 'b1', verdict: 'red' };
  assert.equal(receiptByKey([other, receipt], receiptKey('c1', 'b1')), receipt);
  assert.equal(receiptByKey(new Map([[receiptKey('c2', 'b1'), other]]), receiptKey('c2', 'b1')), other);
  assert.equal(receiptByKey([receipt], receiptKey('x', 'y')), null);
});

test('receipt.key.tooling: [C7] two runs with the same candidate and base but different tooling pins get different receipt keys and never reuse each other', () => {
  assert.notEqual(receiptKey('c1', 'b1', 't1'), receiptKey('c1', 'b1', 't2'));
  assert.equal(receiptKey('c1', 'b1'), receiptKey('c1', 'b1', 'c1'), 'unpinned tooling is the candidate own tree');
  const pinned = { candidate: 'c1', base: 'b1', tooling: 't1', verdict: 'green' };
  assert.equal(receiptByKey([pinned], receiptKey('c1', 'b1', 't2')), null);
  assert.deepEqual(reusable(pinned, { candidate: 'c1', base: 'b1', tooling: 't2' }), { reuse: false, code: 'TOOLING_CHANGED' });
  assert.deepEqual(reusable(pinned, { candidate: 'c1', base: 'b1', tooling: 't1' }), { reuse: true, code: null });
});

test('receipt.reuse.refusals: [C7] clause 1: every refusal of reusable says reuse is false, and only a full match says true', () => {
  const same = { candidate: 'c1', base: 'b1' };
  const cases = [
    [null, 'NO_RECEIPT'],
    [undefined, 'NO_RECEIPT'],
    [{ ...receipt, verdict: 'red' }, 'NOT_GREEN'],
    [{ ...receipt, candidate: 'c2' }, 'CANDIDATE_CHANGED'],
    [{ ...receipt, base: 'b2' }, 'BASE_MOVED'],
  ];
  for (const [given, code] of cases) assert.deepEqual(reusable(given, same), { reuse: false, code }, code);
  assert.equal(reusable(receipt, same).reuse, true);
});

test('receipt.key.types: [C7] receiptKey refuses a candidate or base that is empty, missing or not a string', () => {
  for (const [candidate, base] of [['', 'b'], [5, 'b'], [null, 'b'], [undefined, 'b'], ['c', ''], ['c', 5], ['c', null], ['c', undefined]]) {
    assert.throws(() => receiptKey(candidate, base), { code: 'RECEIPT_KEY' }, JSON.stringify([candidate, base]));
  }
  assert.equal(receiptKey('c', 'b'), 'c@b@c');
});
