/** A view approval is planned as apply-and-commit on a clean checkout, otherwise the one command left [C7,#1310]. @pullboard-test-input source-cell packages/spec */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planViewApproval } from '../../src/logic/row/apply-plan.js';

const person = { name: 'Corey Olson', email: 'corey@example.invalid' };

test('clause 1: a clean checkout and a decided row plan apply and commit with message and author [C7]', () => {
  assert.deepEqual(planViewApproval({ id: 'G1.2', decision: 'approve' }, { clean: true }, person),
    { action: 'apply-and-commit', row: 'G1.2', message: 'spec: approve G1.2', author: 'Corey Olson <corey@example.invalid>' });
  assert.equal(planViewApproval({ id: 'G1.2', decision: 'decline' }, { clean: true }, person).message, 'spec: decline G1.2');
});

test('clause 1: a dirty checkout plans left with the single command to run [C7]', () => {
  const plan = planViewApproval({ id: 'G1.2', decision: 'approve' }, { clean: false }, person);
  assert.equal(plan.action, 'left');
  assert.equal(plan.command, 'pullboard spec apply');
  assert.match(plan.why, /G1\.2/u);
});

test('clause 2: a stale decision plans left naming the row and its next command [C7]', () => {
  const plan = planViewApproval({ id: 'S4', decision: 'approve', stale: { why: 'the row text changed', next: 'pullboard spec approve S4' } }, { clean: true }, person);
  assert.deepEqual([plan.action, plan.row, plan.command], ['left', 'S4', 'pullboard spec approve S4']);
});

test('clause 2: a held decision plans left naming the row and its next command, even on a clean checkout [C7]', () => {
  const plan = planViewApproval({ id: 'S5', decision: 'approve', held: { why: 'a hold', next: 'pullboard spec unhold S5' } }, { clean: true }, person);
  assert.deepEqual([plan.action, plan.row, plan.command], ['left', 'S5', 'pullboard spec unhold S5']);
  assert.equal(planViewApproval({ id: 'S6', decision: 'approve', held: {} }, { clean: true }, person).command, 'pullboard spec apply S6');
});
