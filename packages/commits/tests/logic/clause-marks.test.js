/** @pullboard-test-input source-cell packages/commits */
/** clauseMarks reads a frozen bar and its ticks and returns one mark per clause, with no ticks leaving every clause unmarked [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseMarks } from '../../index.js';

const BAR = '1. a.test.js: it names the file [test]\n2. the page renders [measurement]\n3. the docs say why [reasoning]';

test('commits.logic-clause-marks.clause-1-clausemarks-returns-one-mark: clause 1: clauseMarks returns one mark per clause with its tick state [C7]', () => {
  const marks = clauseMarks(BAR, [2, { clause: 3, evidence: 'run abc' }]);
  assert.deepEqual(marks.map(mark => [mark.number, mark.ticked, mark.evidence]), [[1, false, null], [2, true, null], [3, true, 'run abc']]);
  assert.match(marks[0].text, /^a\.test\.js: it names the file \[test\]$/u);
});

test('commits.logic-clause-marks.clause-1-an-item-with-no-ticks-returns: clause 1: an item with no ticks returns every clause unmarked [C7]', () => {
  for (const ticks of [undefined, null, []]) {
    const marks = clauseMarks(BAR, ticks);
    assert.equal(marks.length, 3);
    assert.ok(marks.every(mark => mark.ticked === false && mark.evidence === null));
  }
  assert.deepEqual(clauseMarks('', []), []);
});
