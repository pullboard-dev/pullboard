/** @pullboard-test-input source-cell packages/store */
/** With gate.machineVerifyPulled on, a pulled gate whose receipt has a failing clause command refuses MACHINE_CLAUSE_RED naming the clause [C7,#10254]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN } from '../fixtures/machine-pulled.js';
import { fixture } from '../fixtures/machine-pulled.js';
import { applyRunReceipt } from '../../src/io/board/run.js';
import { getItem } from '../../src/io/board/query.js';

const GREEN = { outcome: 'review', summary: { gate: { green: true, source: MAIN }, machineReceipts: ['r1', 'r2'] } };

test('store.io-machine-pulled-red.clause-1-refuses-naming-clause: clause 1: a pulled gate whose clause 1 command receipt failed refuses MACHINE_CLAUSE_RED naming clause 1, records no accept verdict and leaves the item unlanded [C7,#10254]', t => {
  const { board, id } = fixture(t, true);
  assert.throws(() => applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, ...GREEN }, { machineVerifyPulled: true }),
    error => error.code === 'MACHINE_CLAUSE_RED' && /clause 1 failed/u.test(error.message) && /node --test two\.test\.js/u.test(error.message));
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM verdict WHERE item_id = ?').get(id).n, 0);
  assert.equal(getItem(board, id).item_merged_commit ?? null, null);
  assert.equal(board.db.prepare("SELECT run_state FROM run WHERE run_job = 'gate-1'").get().run_state, 'done');
});

test('store.io-machine-pulled-red.clause-1-setting-off-no-refusal: clause 1: with gate.machineVerifyPulled off the same failing receipt refuses nothing [C7,#10254]', t => {
  const { board } = fixture(t, true);
  assert.deepEqual(applyRunReceipt(board, { by: 'coordinator', job: 'gate-1', attempt: 1, ...GREEN }, { machineVerifyPulled: false }), { applied: true });
});
