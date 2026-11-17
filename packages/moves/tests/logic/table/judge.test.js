/** The pure judge sorts each recorded move by which table, released or current, answered as the board did [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeRecords } from '../../../index.js';

const REFUSED_A = { decision: 'refused', code: 'NOT_YOURS' };
const REFUSED_B = { decision: 'refused', code: 'NOT_CLAIMED' };
const record = (id, recorded = { refused: 'NOT_YOURS' }) => ({ event: { id }, recorded });
const classOf = (released, current) => judgeRecords([record(1)], { 1: released }, { 1: current }).rows[0].class;

test('moves.judge.same-and-current-drifted: judgeRecords gives same when both answers match the board and current-drifted when only the released one does [C7]', () => {
  assert.equal(classOf(REFUSED_A, REFUSED_A), 'same');
  assert.equal(classOf(REFUSED_A, REFUSED_B), 'current-drifted');
  const events = [{ kind: 'release', by: 'a' }];
  const accepted = judgeRecords([record(2, { events })], new Map([[2, { decision: 'accepted', events }]]), new Map([[2, { decision: 'accepted', events: [] }]]));
  assert.equal(accepted.rows[0].class, 'current-drifted');
  assert.deepEqual(accepted.counts, { same: 0, currentDrifted: 1, releasedWrong: 0, bothDiffer: 0 });
});

test('moves.judge.released-wrong-and-both-differ: judgeRecords gives released-wrong when only the current answer matches the board and both-differ when neither does [C7]', () => {
  assert.equal(classOf(REFUSED_B, REFUSED_A), 'released-wrong');
  assert.equal(classOf(REFUSED_B, { decision: 'accepted', events: [] }), 'both-differ');
  assert.equal(classOf(undefined, undefined), 'both-differ');
  const judged = judgeRecords([record(1), record(2), record(3), record(4)], { 1: REFUSED_A, 2: REFUSED_B, 3: REFUSED_B, 4: REFUSED_A }, { 1: REFUSED_A, 2: REFUSED_A, 3: REFUSED_B, 4: REFUSED_B });
  assert.deepEqual(judged.counts, { same: 1, currentDrifted: 1, releasedWrong: 1, bothDiffer: 1 });
  assert.deepEqual(judged.rows[1], { event: 2, class: 'released-wrong', recorded: { decision: 'refused', code: 'NOT_YOURS' }, released: REFUSED_B, current: REFUSED_A });
});

test('moves.judge.pure-and-ordered: judgeRecords reads no clock, file or git: the same inputs in any order give the same rows [C7]', () => {
  const records = [record(3), record('b'), record(1), record('a')];
  const answers = { 1: REFUSED_A, 3: REFUSED_B, a: REFUSED_A, b: REFUSED_A };
  const forward = judgeRecords(records, answers, answers);
  const backward = judgeRecords([...records].reverse(), answers, answers);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.rows.map(row => row.event), [1, 3, 'a', 'b']);
  const before = JSON.stringify(records);
  judgeRecords(records, answers, answers);
  assert.equal(JSON.stringify(records), before);
});
