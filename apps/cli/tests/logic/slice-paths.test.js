/** With composeLanding on, a slice is never accepted alone, a rejected slice returns alone, and a parent waits for its slices [C7,#11346]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceVerdictProblem } from '../../src/logic/slice-paths.js';

const submitted = { id: 2, status: 'submitted' };
const open = { id: 3, status: 'open' };

test('cli.logic-slice-paths.slice-verdicts-with-composelanding-on: clause 1: with composeLanding true an ACCEPT on a slice is SLICE_REVIEWED_WITH_PARENT and a REJECT on a slice is null [C7]', () => {
  assert.equal(sliceVerdictProblem({ decision: 'ACCEPT', isSlice: true, sliceChildren: [], composeLanding: true }), 'SLICE_REVIEWED_WITH_PARENT');
  assert.equal(sliceVerdictProblem({ decision: 'REJECT', isSlice: true, sliceChildren: [], composeLanding: true }), null);
});

test('cli.logic-slice-paths.parent-verdicts-and-setting-off: clause 2: with composeLanding true an ACCEPT on a parent with an unsubmitted slice is SLICES_PENDING, and with it false every case is null [C7]', () => {
  assert.equal(sliceVerdictProblem({ decision: 'ACCEPT', isSlice: false, sliceChildren: [submitted, open], composeLanding: true }), 'SLICES_PENDING');
  assert.equal(sliceVerdictProblem({ decision: 'ACCEPT', isSlice: false, sliceChildren: [submitted], composeLanding: true }), null);
  assert.equal(sliceVerdictProblem({ decision: 'ACCEPT', isSlice: false, sliceChildren: [], composeLanding: true }), null);
  for (const decision of ['ACCEPT', 'REJECT']) {
    for (const isSlice of [true, false]) {
      assert.equal(sliceVerdictProblem({ decision, isSlice, sliceChildren: [open], composeLanding: false }), null);
    }
  }
});
