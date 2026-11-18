/** @pullboard-test-input packages/gate/src/logic/test/journey-check.js */
/** A delete-tagged journey keeps its tag only while the covering cells' mutation scores do not drop without it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveringCells } from '../../../src/logic/test/journey-check.js';
import { holdShare } from '../../../src/logic/test/journey-check.js';
import { judgeJourney } from '../../../src/logic/test/journey-check.js';
import { retagChecked } from '../../../src/logic/test/journey-check.js';
import { scoreWithAndWithout } from '../../../src/logic/test/journey-check.js';

const J = 'apps/cli/journeys/edges/a.test.js';
const fault = (...caughtBy) => ({ caughtBy });
const row = (file, kind, specs, extra = {}) => ({ file, kind, specs, ...extra });

test('gate.logic-test-journey-check.the-covering-cells-are-the: the covering cells are the ones whose own tests cite the journey spec ids, most shared first [C7]', () => {
  const rows = [
    row('packages/a/tests/x.test.js', 'cell unit', ['S1']),
    row('packages/b/tests/y.test.js', 'contract', ['S1', 'S2']),
    row('packages/b/tests/z.test.js', 'cell unit', ['S9']),
    row('apps/c/tests/w.test.js', 'cell unit', ['S2', 'S3']),
    row('test/root.test.js', 'cell unit', ['S1']),
    row('apps/cli/journeys/other/j.test.js', 'journey', ['S1']),
  ];
  assert.deepEqual(coveringCells(rows, row(J, 'journey', ['S1', 'S2'])), [{ cell: 'packages/b', shared: 2 }, { cell: 'apps/c', shared: 1 }, { cell: 'packages/a', shared: 1 }]);
  assert.equal(coveringCells(rows, row(J, 'journey', ['S1', 'S2']), 1).length, 1);
});

test('gate.logic-test-journey-check.the-score-with-and-without: the score with and without a journey counts the faults only the journey caught [C7]', () => {
  const report = { faults: [fault('cell.test.js', J), fault(J), fault('cell.test.js'), fault()] };
  assert.deepEqual(scoreWithAndWithout(J, report), { seeded: 4, with: 3, without: 2, dropped: true, blind: false, skipped: 0, capped: 0 });
  assert.deepEqual(scoreWithAndWithout(J, { faults: [], redBefore: [J], skipped: 2, capped: 1 }), { seeded: 0, with: 0, without: 0, dropped: false, blind: true, skipped: 2, capped: 1 });
  assert.equal(scoreWithAndWithout(J, { faults: [fault('cell.test.js'), fault('cell.test.js', J)] }).dropped, false);
});

test('gate.logic-test-journey-check.a-journey-whose-removal-drops: a journey whose removal drops a covering cell score is retagged convert, naming the cell [C7]', () => {
  const verdict = judgeJourney(J, [{ cell: 'packages/a', report: { faults: [fault('t.js')] } }, { cell: 'packages/b', report: { faults: [fault(J), fault('t.js')] } }]);
  assert.equal(verdict.verdict, 'convert');
  assert.match(verdict.because, /packages\/b falls from 2 to 1 of 2 faults caught/u);
  const rows = [row(J, 'journey', ['S1'], { tag: 'delete', tagBecause: 'covered' }), row('apps/cli/journeys/edges/b.test.js', 'journey', [], { tag: 'delete', tagBecause: 'covered' })];
  const [moved, same] = retagChecked(rows, [verdict]);
  assert.equal(moved.tag, 'convert');
  assert.match(moved.tagBecause, /mutation score drops without it/u);
  assert.equal(same.tag, 'delete');
});

test('gate.logic-test-journey-check.a-journey-stays-delete-when: a journey stays delete when no covering cell scores lower without it, and is unmeasured when nothing was seeded [C7]', () => {
  assert.equal(judgeJourney(J, [{ cell: 'packages/a', report: { faults: [fault('t.js', J), fault('t.js')] } }]).verdict, 'hold');
  assert.equal(judgeJourney(J, [{ cell: 'packages/a', report: { faults: [] } }]).verdict, 'unmeasured');
  assert.equal(judgeJourney(J, []).verdict, 'unmeasured');
});

test('gate.logic-test-journey-check.the-share-of-sampled-delete: the share of sampled delete tags that hold is held over sampled [C7]', () => {
  const verdicts = ['hold', 'hold', 'hold', 'convert', 'unmeasured'].map(verdict => ({ verdict }));
  assert.deepEqual(holdShare(verdicts), { sampled: 5, held: 3, converted: 1, unmeasured: 1, share: 0.6 });
  assert.equal(holdShare([]).share, 0);
});
