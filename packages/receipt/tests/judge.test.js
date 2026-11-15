/** The receipt cell judges collected results purely and records the verdict before bookkeeping [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../index.js';
import { verdictStep } from '../index.js';
import { settle } from '../index.js';
import { SECTIONS } from '../index.js';

const green = () => Object.fromEntries(SECTIONS.map((name) => [name, { outcome: 'pass' }]));

test('receipt.judge.sections: [C7] judge gives per-section outcomes and codes, pure, with no I/O', () => {
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

test('receipt.settle.order: [C7] the verdict step stores the receipt id and bookkeeping runs after and cannot change it', () => {
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

test('receipt.judge.code: [C7] a section keeps its own non-empty string code, and any other code reads null', () => {
  const codeOf = (code) => judge({ ...green(), proof: { outcome: 'fail', code } }).sections.proof.code;
  assert.equal(codeOf('TEST_FAILURE'), 'TEST_FAILURE');
  for (const bad of ['', 7, null, undefined, {}]) assert.equal(codeOf(bad), null, String(bad));
  assert.equal(judge({ ...green(), proof: { outcome: 'fail', code: '' } }).code, 'PROOF', 'a failed section with no code is named by the section');
  assert.equal(judge({ ...green(), proof: { outcome: 'fail', code: 'TEST_FAILURE' } }).code, 'TEST_FAILURE');
});
