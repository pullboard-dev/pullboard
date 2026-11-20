/** A release that calls an item ineligible must say why, so the next builder has something to act on [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseReasonProblem } from '../../src/logic/reasons.js';

test('store.logic-reasons.ineligible-empty-note-refused: INELIGIBLE with an empty or blank note is refused naming the note to give; other releases are unchanged [C7]', () => {
  for (const note of [undefined, '', '   ', null]) {
    const problem = releaseReasonProblem('INELIGIBLE', note);
    assert.equal(problem?.code, 'RELEASE_REASON');
    assert.match(problem.message, /--note/u);
  }
  assert.equal(releaseReasonProblem('INELIGIBLE', 'names a file that does not exist'), null);
  assert.equal(releaseReasonProblem('BLOCKED', undefined), null);
  assert.equal(releaseReasonProblem('TOO_LARGE', ''), null);
  assert.equal(releaseReasonProblem('OTHER', ' ')?.code, 'RELEASE_REASON');
});
