/** The receipt cell judges collected results purely and records the verdict before bookkeeping [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../index.js';
import { verdictStep } from '../index.js';
import { settle } from '../index.js';
import { SECTIONS } from '../index.js';
import { receiptKey } from '../index.js';
import { reusable } from '../index.js';
import { receiptByKey } from '../index.js';

const green = () => Object.fromEntries(SECTIONS.map((name) => [name, { outcome: 'pass' }]));

test('clause 1: [C7] judge gives per-section outcomes and codes, pure, with no I/O', () => {
  const collected = { ...green(), proof: { outcome: 'fail', code: 'TEST_FAILURE' }, cells: { outcome: 'skip' } };
  const before = JSON.stringify(collected);
  const one = judge(collected);
  assert.deepEqual(one, judge(collected));
  assert.equal(JSON.stringify(collected), before);
  assert.equal(one.verdict, 'red');
  assert.equal(one.code, 'TEST_FAILURE');
  assert.deepEqual(one.sections.proof, { outcome: 'fail', code: 'TEST_FAILURE' });
  assert.deepEqual(one.sections.cells, { outcome: 'skip', code: null });
  assert.equal(judge(green()).verdict, 'green');
  const lost = judge({ ...green(), static: undefined });
  assert.deepEqual([lost.verdict, lost.code, lost.sections.static.outcome], ['infra', 'SECTION_MISSING', 'infra']);
  assert.equal(judge({ ...green(), static: { outcome: 'infra', code: 'RUNNER_LOST' }, proof: { outcome: 'fail' } }).verdict, 'red');
  assert.throws(() => judge(null), { code: 'JUDGE_INPUT' });
});

test('clause 1: [C7] the verdict step stores the receipt id and bookkeeping runs after and cannot change it', () => {
  const order = [];
  const result = settle(green(), 'receipt-1', {
    record: (step) => order.push(['record', step.payload.receipt, step.payload.verdict]),
    bookkeeping: () => { order.push(['bookkeeping']); throw new Error('cache full'); },
  });
  assert.deepEqual(order, [['record', 'receipt-1', 'green'], ['bookkeeping']]);
  assert.equal(result.step.payload.verdict, 'green');
  assert.equal(result.bookkeepingError, 'cache full');
  assert.throws(() => verdictStep(judge(green()), ''), { code: 'VERDICT_RECEIPT' });
  assert.throws(() => { result.step.payload.verdict = 'red'; }, TypeError);
});

/** The receipt cell keys receipts by candidate and base and says when a composition can reuse one [C7]. */

const receipt = { candidate: 'c1', base: 'b1', verdict: 'green' };

test('clause 1: [C7] receiptKey is stable per (candidate, base) and refuses a missing id', () => {
  assert.equal(receiptKey('c1', 'b1'), receiptKey('c1', 'b1'));
  assert.notEqual(receiptKey('c1', 'b1'), receiptKey('b1', 'c1'));
  assert.throws(() => receiptKey('c1', ''), { code: 'RECEIPT_KEY' });
});

test('clause 1: [C7] reusable says when a landing composition can reuse a submit receipt', () => {
  assert.deepEqual(reusable(receipt, { candidate: 'c1', base: 'b1' }), { reuse: true, code: null });
  assert.equal(reusable(receipt, { candidate: 'c1', base: 'b2' }).code, 'BASE_MOVED');
  assert.equal(reusable(receipt, { candidate: 'c2', base: 'b1' }).code, 'CANDIDATE_CHANGED');
  assert.equal(reusable({ ...receipt, verdict: 'red' }, { candidate: 'c1', base: 'b1' }).code, 'NOT_GREEN');
  assert.equal(reusable(null, { candidate: 'c1', base: 'b1' }).code, 'NO_RECEIPT');
});

test('clause 1: [C7] review reads a receipt by key', () => {
  const other = { candidate: 'c2', base: 'b1', verdict: 'red' };
  assert.equal(receiptByKey([other, receipt], receiptKey('c1', 'b1')), receipt);
  assert.equal(receiptByKey(new Map([[receiptKey('c2', 'b1'), other]]), receiptKey('c2', 'b1')), other);
  assert.equal(receiptByKey([receipt], receiptKey('x', 'y')), null);
});
