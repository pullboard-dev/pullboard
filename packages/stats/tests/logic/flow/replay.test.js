/** replayTuned replays a history with the line tuner closing cycles as it goes, beside the untuned replay [C7]. @pullboard-test-input source-cell packages/stats */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayFlow } from '../../../src/logic/flow/replay.js';
import { replayTuned } from '../../../src/logic/flow/replay.js';

const MINUTE = 60_000;
const START = Date.parse('2026-11-01T00:00:00.000Z');

/** Thirty items added together, built one every half hour by one seat, then reviewed one at a time by a second seat and landed by a third. */
function history() {
  const rows = [];
  let reviewerFree = 0;
  for (let k = 0; k < 30; k += 1) {
    const claim = k * 30, submit = claim + 10, reserve = Math.max(submit + 5, reviewerFree), accept = reserve + 50;
    reviewerFree = accept;
    rows.push([0, 'add', k + 1, 'core-1'], [claim, 'claim', k + 1, 'core-1'], [submit, 'submit', k + 1, 'core-1'],
      [reserve, 'reserve', k + 1, 'core-2'], [accept, 'accept', k + 1, 'core-2'], [accept + 5, 'merged', k + 1, 'core-3']);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.map(([minute, kind, item, by], index) => ({ event_id: index + 1, event_at: new Date(START + minute * MINUTE).toISOString(), event_kind: kind, item_id: item, event_by: by }));
}

test('stats.logic-flow-replay.tuned-applies-cycles: clause 1: replayTuned replays with replayFlow and at each due cycle applies the one chooseTuning change over the policy settings, then reverts it at the next due cycle when the constraint got worse [C7]', () => {
  const events = history();
  const { tuned, untuned, changes } = replayTuned(events, { settings: { wipPerReviewer: 2.75 } });
  const change = (at, kind, from, to) => ({ at, reason: 'cycle', kind, stage: 'reviewWait', key: 'wipPerReviewer', from, to });
  assert.deepEqual(changes, [
    change('2026-11-01T06:55:00.000Z', 'setting', 2.75, 3),
    change('2026-11-01T13:35:00.000Z', 'revert', 3, 2.75),
    change('2026-11-01T20:15:00.000Z', 'setting', 2.75, 3),
  ]);
  const before = untuned.replay.items.filter(item => Date.parse(item.landedAt) <= Date.parse(changes[0].at));
  assert.ok(before.length >= 8, 'a cycle closes only after eight landings');
  assert.deepEqual(tuned.replay.items.filter(item => Date.parse(item.landedAt) <= Date.parse(changes[0].at)), before, 'rows landed up to a change are kept as they were');
  assert.equal(tuned.replay.items.length, untuned.replay.items.length);
  assert.equal(tuned.replay.mode, 'predicted');
  assert.equal(tuned.replay.policy.settings.wipPerReviewer, 3, 'the policy the tuned rows ended on carries the last change');
  assert.equal(untuned.replay.policy.settings.wipPerReviewer, 2.75);
});

test('stats.logic-flow-replay.tuned-side-by-side: clause 2: replayTuned returns tuned, untuned and changes, untuned equals replayFlow, both carry each stage median, and the same input gives the same result twice [C7]', () => {
  const events = history(), policy = { settings: { wipPerReviewer: 2.75 } };
  const first = replayTuned(events, policy);
  assert.deepEqual(Object.keys(first).sort(), ['changes', 'tuned', 'untuned']);
  assert.deepEqual(first.untuned, replayFlow(events, policy));
  for (const side of [first.tuned, first.untuned]) {
    for (const stage of ['build', 'reviewWait', 'review', 'sendBackIdle', 'mergeWait']) assert.ok(Object.hasOwn(side.replay.stages[stage], 'medianMinutes'), `${stage} carries a median`);
  }
  assert.deepEqual(replayTuned(events, policy), first);
  const none = replayTuned(events, {});
  assert.deepEqual(none.changes, [], 'a policy with no numeric line setting has no setting for the tuner to move');
  assert.deepEqual(none.tuned, none.untuned);
});
