/** replayWindow builds a flow window and its constraint from replayFlow items [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayWindow } from '../../../src/logic/flow/window.js';
import { chooseTuning } from '../../../src/logic/flow/tune/choose.js';

const item = (landedAt, stages) => ({ landedAt, stages: { build: 0, reviewWait: 0, review: 0, sendBackIdle: 0, mergeWait: 0, ...stages } });

test('stats.logic-flow-window.replay-window: clause 1: replayWindow counts landed items in the window and names the stage with the most minutes over target [C7]', () => {
  const items = [
    item('2026-11-10T00:00:00.000Z', { build: 100 }),
    item('2026-11-11T00:00:00.000Z', { build: 300, review: 100 }),
    item('2026-11-12T00:00:00.000Z', { reviewWait: 50, review: 70 }),
    item('2026-11-13T00:00:00.000Z', { build: 999 }),
  ];
  const window = replayWindow(items, Date.parse('2026-11-10T00:00:00.000Z'), Date.parse('2026-11-12T00:00:00.000Z'));
  assert.equal(window.landedItems, 2);
  assert.equal(window.stages.build.targetMinutes, 240);
  assert.equal(window.stages.build.overTargetMinutes, 60);
  assert.equal(window.stages.reviewWait.overTargetMinutes, 20);
  assert.equal(window.stages.review.overTargetMinutes, 50 + 10);
  assert.equal(window.stages.mergeWait.overTargetMinutes, 0);
  assert.deepEqual(window.constraint, { stage: 'build', overTargetMinutes: 60 });
});

test('stats.logic-flow-window.replay-window-empty: clause 2: a window with no landed item gives the null constraint chooseTuning reads [C7]', () => {
  const window = replayWindow([item('2026-11-01T00:00:00.000Z', { build: 500 })], Date.parse('2026-11-10T00:00:00.000Z'), Date.parse('2026-11-12T00:00:00.000Z'));
  assert.equal(window.landedItems, 0);
  assert.deepEqual(window.constraint, { stage: null, overTargetMinutes: 0 });
  assert.doesNotThrow(() => chooseTuning([window, window], {}));
});
