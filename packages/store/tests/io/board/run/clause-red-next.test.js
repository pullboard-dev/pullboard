/** @pullboard-test-input source-cell packages/store */
/** The MACHINE_CLAUSE_RED refusal tells the builder to fix, commit and submit again, never to merge main, and keeps naming the clause, command and receipt [C7,#10605]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/machine-pulled.js';
import { applyRunReceipt } from '../../../../src/io/board/run.js';

const GREEN = { outcome: 'review', summary: { gate: { green: true, source: 'a'.repeat(40) }, machineReceipts: ['r1', 'r2'] } };

function refusal(t) {
  const { board } = fixture(t, true);
  try {
    applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, ...GREEN }, { machineVerifyPulled: true });
  } catch (error) {
    return error;
  }
  return assert.fail('expected MACHINE_CLAUSE_RED');
}

test('store.io-board-run-clause-red-next.clause-1-no-merge-main: clause 1: the MACHINE_CLAUSE_RED refusal says fix it, commit and submit again (submit composes current main), with no "merge main" [C7,#10605]', t => {
  const error = refusal(t);
  assert.equal(error.code, 'MACHINE_CLAUSE_RED');
  assert.match(error.message, /fix it, commit and submit again \(submit composes current main\)/u);
  assert.doesNotMatch(error.message, /merge main/u);
});

test('store.io-board-run-clause-red-next.clause-2-names-clause-command-receipt: clause 2: the refusal still names the clause, the command and the receipt [C7,#10605]', t => {
  const error = refusal(t);
  assert.match(error.message, /clause 1 failed on the pulled gate \(node --test two\.test\.js, receipt r2\)/u);
});
