/** @pullboard-test-input source-tree */
/** The receipt cell keys receipts by candidate and base and says when a composition can reuse one [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptKey, reusable, receiptByKey } from '../packages/receipt/index.js';

const receipt = { candidate: 'c1', base: 'b1', verdict: 'green' };

test('clause 1: receiptKey is stable per (candidate, base) and refuses a missing id', () => {
  assert.equal(receiptKey('c1', 'b1'), receiptKey('c1', 'b1'));
  assert.notEqual(receiptKey('c1', 'b1'), receiptKey('b1', 'c1'));
  assert.throws(() => receiptKey('c1', ''), { code: 'RECEIPT_KEY' });
});

test('clause 1: reusable says when a landing composition can reuse a submit receipt', () => {
  assert.deepEqual(reusable(receipt, { candidate: 'c1', base: 'b1' }), { reuse: true, code: null });
  assert.equal(reusable(receipt, { candidate: 'c1', base: 'b2' }).code, 'BASE_MOVED');
  assert.equal(reusable(receipt, { candidate: 'c2', base: 'b1' }).code, 'CANDIDATE_CHANGED');
  assert.equal(reusable({ ...receipt, verdict: 'red' }, { candidate: 'c1', base: 'b1' }).code, 'NOT_GREEN');
  assert.equal(reusable(null, { candidate: 'c1', base: 'b1' }).code, 'NO_RECEIPT');
});

test('clause 1: review reads a receipt by key', () => {
  const other = { candidate: 'c2', base: 'b1', verdict: 'red' };
  assert.equal(receiptByKey([other, receipt], receiptKey('c1', 'b1')), receipt);
  assert.equal(receiptByKey(new Map([[receiptKey('c2', 'b1'), other]]), receiptKey('c2', 'b1')), other);
  assert.equal(receiptByKey([receipt], receiptKey('x', 'y')), null);
});
