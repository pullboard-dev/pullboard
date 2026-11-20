/** The line controller chooses one in-range setting change, or a request to the person, and reverts a change that made it worse [C7,#1099]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseTuning } from '../../../../src/logic/flow/tune/choose.js';
import { revertTuning } from '../../../../src/logic/flow/tune/choose.js';

const window = (stage, overTargetMinutes = 90) => ({ constraint: stage ? { stage, overTargetMinutes } : null });
const fixes = {
  review: { needs: 'setting', key: 'review.slots', value: 2, min: 1, max: 4, step: 1 },
  build: { needs: 'seat' },
  mergeWait: { needs: 'machine' },
  sendBackIdle: { needs: 'scope' },
};

test('stats.logic-flow-tune-choose.one-change-on-a-repeated-constraint: clause 1: chooseTuning returns one setting change inside its range only when the same constraint stage shows in two consecutive windows [C7,#1099]', () => {
  assert.deepEqual(chooseTuning([window('review'), window('review')], fixes), { kind: 'setting', stage: 'review', key: 'review.slots', from: 2, to: 3 });
  assert.deepEqual(chooseTuning([window('build'), window('review'), window('review')], fixes), { kind: 'setting', stage: 'review', key: 'review.slots', from: 2, to: 3 });
  const atMax = { review: { ...fixes.review, value: 4 } };
  assert.deepEqual(chooseTuning([window('review'), window('review')], atMax), { kind: 'none' }, 'a change never leaves its range');
  const clamped = { review: { ...fixes.review, value: 3, step: 5 } };
  assert.equal(chooseTuning([window('review'), window('review')], clamped).to, 4);
});

test('stats.logic-flow-tune-choose.none-when-the-stage-differs: clause 1: chooseTuning returns none when the constraint stage differs between the two windows or is absent [C7,#1099]', () => {
  assert.deepEqual(chooseTuning([window('review'), window('mergeWait')], fixes), { kind: 'none' });
  assert.deepEqual(chooseTuning([window('review')], fixes), { kind: 'none' });
  assert.deepEqual(chooseTuning([window(null), window(null)], fixes), { kind: 'none' });
  assert.deepEqual(chooseTuning([], fixes), { kind: 'none' });
});

test('stats.logic-flow-tune-choose.a-request-for-the-person: clause 1: chooseTuning returns a person request instead of a setting when the fix needs a seat, a machine or a scope call [C7,#1099]', () => {
  assert.deepEqual(chooseTuning([window('build'), window('build')], fixes), { kind: 'request', stage: 'build', needs: 'seat' });
  assert.deepEqual(chooseTuning([window('mergeWait'), window('mergeWait')], fixes), { kind: 'request', stage: 'mergeWait', needs: 'machine' });
  assert.deepEqual(chooseTuning([window('sendBackIdle'), window('sendBackIdle')], fixes), { kind: 'request', stage: 'sendBackIdle', needs: 'scope' });
});

test('stats.logic-flow-tune-choose.revert-when-hours-per-item-rose: clause 2: revertTuning returns revert when the constraint hours over target per landed item rose after the change and keep when it did not [C7,#1099]', () => {
  const change = { kind: 'setting', stage: 'review', key: 'review.slots', from: 2, to: 3 };
  assert.equal(revertTuning(change, { overTargetMinutes: 120, landed: 8 }, { overTargetMinutes: 120, landed: 4 }), 'revert', 'same hours over, fewer landed');
  assert.equal(revertTuning(change, { overTargetMinutes: 60, landed: 8 }, { overTargetMinutes: 120, landed: 8 }), 'revert', 'more hours over, same landed');
  assert.equal(revertTuning(change, { overTargetMinutes: 120, landed: 8 }, { overTargetMinutes: 120, landed: 8 }), 'keep', 'equal is not a rise');
  assert.equal(revertTuning(change, { overTargetMinutes: 120, landed: 4 }, { overTargetMinutes: 60, landed: 8 }), 'keep', 'fewer hours per item');
  assert.equal(revertTuning(change, { overTargetMinutes: 0, landed: 8 }, { overTargetMinutes: 30, landed: 0 }), 'revert', 'nothing landed with minutes over is worse than none over');
});
