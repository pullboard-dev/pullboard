/** One item's timeline: stage rows with deltas, buckets that add up to the wall time, and stretches nothing explains [C7,#12143]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timelineOf } from '../../src/logic/timeline.js';
import { TIMELINE_BUCKETS } from '../../src/logic/timeline.js';
import { TIMELINE_STAGES } from '../../src/logic/timeline.js';
import { UNACCOUNTED } from '../../src/logic/timeline.js';
import { WAIT_REASONS } from '../../src/logic/timeline.js';

const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;

/** A board event at an offset from T0. */
function event(id, offset, kind, detail = {}, by = 'core-1') {
  return { id, at: new Date(T0 + offset).toISOString(), by, kind, item: 7, detail: JSON.stringify(detail) };
}
/** A gate or landing job with its steps, as the job tables hold them. */
function job(id, kind, created, steps) {
  return { job: { id, kind, created: T0 + created }, steps: steps.map(([name, offset, payload = '{}']) => ({ job: id, name, at: T0 + offset, payload })) };
}
const stagesOf = rows => rows.map(row => row.stage);

test('stats.timeline.item-rows: clause 1: events, a gate job and its steps become time-ordered rows with stage, edge, actor, ref and delta, a claim after a release is re-claimed [C7,#12143]', () => {
  const gate = job('gate:1', 'gate', 30 * MIN + 5 * SEC, [['queued', 30 * MIN + 5 * SEC], ['claimed', 31 * MIN, '{"runner":"r1"}'], ['green', 36 * MIN]]);
  const { rows, unmapped } = timelineOf({
    events: [event(1, 0, 'add', {}, 'coordinator'), event(2, 30 * SEC, 'claim'), event(3, 10 * MIN, 'release', { reasonCode: 'BLOCKED', reason: 'waits' }),
      event(4, 12 * MIN, 'claim'), event(5, 30 * MIN, 'submit'), event(6, 50 * MIN, 'merged', { commit: 'abc1234' }, 'coordinator'), event(7, 51 * MIN, 'fact')],
    jobs: [gate.job], steps: gate.steps,
  });
  assert.deepEqual(stagesOf(rows), ['filed', 'claimed', 'released', 're-claimed', 'submitted', 'gate-queued', 'gate-running', 'gate-settled', 'merged']);
  assert.deepEqual(rows.map(row => row.delta), [null, 30 * SEC, 570 * SEC, 2 * MIN, 18 * MIN, 5 * SEC, 55 * SEC, 5 * MIN, 14 * MIN]);
  assert.equal(rows[2].reason, 'BLOCKED');
  assert.equal(rows[0].actor, 'coordinator');
  assert.equal(rows[6].actor, 'r1');
  assert.equal(rows[7].reason, 'green');
  assert.equal(rows[5].ref, 'gate:1');
  assert.equal(rows[8].ref, 'abc1234');
  assert.deepEqual(rows.map(row => row.edge), ['point', 'start', 'point', 'start', 'point', 'start', 'start', 'end', 'point']);
  for (const row of rows) assert.ok(TIMELINE_STAGES.includes(row.stage) && row.recorded_at === new Date(row.at).toISOString());
  assert.deepEqual(unmapped, [{ kind: 'fact', count: 1 }], 'an event kind no stage names is reported, not dropped');
});

test('stats.timeline.buckets: clause 1: bucket totals plus UNACCOUNTED equal the last row minus filed exactly, and the summary names the longest gap and its reason [C7,#12143]', () => {
  const gate = job('gate:1', 'gate', 20 * MIN, [['claimed', 21 * MIN], ['result', 25 * MIN, '{"outcome":"green"}']]);
  const land = job('land:1', 'landing-run', 40 * MIN, [['running', 40 * MIN + 30 * SEC], ['result', 41 * MIN]]);
  const { summary, rows } = timelineOf({
    events: [event(1, 0, 'add'), event(2, 20 * SEC, 'claim'), event(3, 20 * MIN, 'submit'), event(4, 27 * MIN, 'reserve'), event(5, 40 * MIN, 'accept'), event(6, 41 * MIN, 'merged')],
    jobs: [gate.job, land.job], steps: [...gate.steps, ...land.steps],
  });
  assert.deepEqual(summary.buckets, { building: 20 * MIN, 'waiting for runner': MIN, testing: 4 * MIN, 'waiting for review': 2 * MIN, reviewing: 13 * MIN, 'waiting to land': 30 * SEC, landing: 30 * SEC, rework: 0 });
  assert.deepEqual(Object.keys(summary.buckets), [...TIMELINE_BUCKETS]);
  const total = Object.values(summary.buckets).reduce((sum, ms) => sum + ms, 0) + summary.unaccounted_ms;
  assert.equal(total, rows.at(-1).at - rows[0].at);
  assert.equal(summary.total_ms, 41 * MIN);
  assert.equal(summary.unaccounted_ms, 0);
  assert.equal(summary.longest_gap.ms, 2 * MIN);
  assert.equal(summary.longest_gap.reason, 'waiting for review');
  assert.deepEqual(Object.keys(summary.waits), [...WAIT_REASONS]);
});

test('stats.timeline.unaccounted: clause 1: a stretch over 60 s with no stage or reason is UNACCOUNTED, a 60 s one is not, and a hold is named HELD [C7,#12143]', () => {
  const over = timelineOf({ events: [event(1, 0, 'add'), event(2, 90 * SEC, 'claim'), event(3, 100 * SEC, 'submit')] }).summary;
  assert.equal(over.unaccounted_ms, 90 * SEC);
  assert.deepEqual(over.unaccounted, [{ from: T0, to: T0 + 90 * SEC, ms: 90 * SEC }]);
  assert.equal(over.longest_gap.reason, UNACCOUNTED);
  assert.equal(over.buckets.building, 10 * SEC);
  const exact = timelineOf({ events: [event(1, 0, 'add'), event(2, 60 * SEC, 'claim'), event(3, 70 * SEC, 'submit')] }).summary;
  assert.equal(exact.unaccounted_ms, 0);
  assert.equal(exact.buckets.building, 70 * SEC, 'the 60 s hand-off belongs to the stage it leads into');
  const held = timelineOf({ events: [event(1, 0, 'add'), event(2, 10 * SEC, 'hold_item'), event(3, 310 * SEC, 'unhold_item'), event(4, 320 * SEC, 'claim'), event(5, 330 * SEC, 'submit')] }).summary;
  assert.equal(held.unaccounted_ms, 0);
  assert.equal(held.waits.HELD, 300 * SEC);
  assert.equal(held.longest_gap.reason, 'HELD');
  assert.equal(held.buckets.building + held.waits.HELD, 330 * SEC);
});
