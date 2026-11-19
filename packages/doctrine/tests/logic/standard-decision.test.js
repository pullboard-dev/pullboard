/** A decision on a standard doctrine default becomes the repo row line it projects [C7,#2007]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standardDecisionLine } from '../../src/logic/standard-decision.js';

const ROW = { id: 'PB2', status: 'approved', tier: 'must', text: "Destructive or irreversible actions wait for the person's OK." };

test('doctrine.logic-standard-decision.approve-returns-the-row-line: clause 1: standardDecisionLine(row, { decision: approve }) returns the DOCTRINE.md row line for that standard id with status approved and the row text unchanged [C7,#2007]', () => {
  assert.equal(standardDecisionLine(ROW, { decision: 'approve' }), `- PB2 [approved, must] ${ROW.text}`);
  assert.equal(standardDecisionLine({ id: 'PB7', text: 'Tests touch nothing outside a sandbox.' }, { decision: 'approve' }), '- PB7 [approved] Tests touch nothing outside a sandbox.');
});

test('doctrine.logic-standard-decision.decline-needs-a-reason: clause 2: standardDecisionLine with decision decline and a reason returns the row line with status wont and the reason in its text, and without a reason refuses with the message composeDoctrine already uses [C7,#2007]', () => {
  assert.equal(standardDecisionLine(ROW, { decision: 'decline', reason: ' we deploy by hand ' }), '- PB2 [wont] we deploy by hand');
  for (const choice of [{ decision: 'decline' }, { decision: 'decline', reason: '   ' }]) {
    assert.throws(() => standardDecisionLine(ROW, choice), error => error.code === 'DECLINE_NEEDS_REASON'
      && error.message.includes('declining a standard rule needs a reason in its text: - PB2 [wont] <why>'));
  }
});
