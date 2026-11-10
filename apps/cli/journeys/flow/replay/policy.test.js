/** Counterfactual queue boundaries, conservative evidence and text-free inputs [R1,R2,A1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayFlow } from '../../../../../packages/stats/index.js';
import { main } from '../../../tests/fixtures/native.js';

const BASE = Date.parse('2026-10-20T00:00:00Z');
/** Structural native events with deliberately unreadable private detail. */
function events(moves) {
  return moves.map(([minute, kind, item, by], index) => ({ event_id: index + 1,
    event_at: new Date(BASE + minute * 60_000).toISOString(), event_kind: kind, item_id: item, event_by: by,
    get event_detail() { throw new Error('private detail must never be read'); } }));
}

/** One complete rejected attempt followed by successful measured rework. */
function rework() {
  return events([[0, 'add', 1, 'coordinator'], [1, 'claim', 1, 'web-1'], [3, 'submit', 1, 'web-1'],
    [3, 'reserve', 1, 'review-1'], [4, 'reject', 1, 'review-1'], [5, 'claim', 1, 'web-2'],
    [8, 'submit', 1, 'web-2'], [9, 'reserve', 1, 'review-1'], [11, 'accept', 1, 'review-1'],
    [13, 'merged', 1, 'coordinator']]);
}

test('replay retains rejected work and fixed seats without reading private detail [R1,R2]', () => {
  const input = rework();
  const recorded = replayFlow(input);
  assert.deepEqual(recorded.replay.items[0].stages, { build: 5, reviewWait: 1, review: 3, sendBackIdle: 1, mergeWait: 2 });
  assert.equal(recorded.replay.items[0].cycleMinutes, 12);
  const predicted = replayFlow(input, { order: [1] });
  assert.equal(predicted.replay.items[0].cycleMinutes, 10, 'remove observed queue waits, not the rejected work');
  assert.equal(predicted.replay.stages.build.medianMinutes, 5);
  assert.equal(predicted.replay.stages.review.medianMinutes, 3);
  assert.deepEqual(new Set(predicted.history.events.map(event => event.event_by)), new Set(['coordinator', 'web-1', 'web-2', 'review-1']));
  assert.deepEqual(replayFlow([...input].reverse(), { order: [1] }), predicted, 'event ids and times define the same input ordering');
});

test('unmeasured cycles are reported rather than invented as zero work [R1,R2]', () => {
  const input = events([[0, 'add', 1, 'coordinator'], [0, 'add', 2, 'coordinator'], [1, 'claim', 1, 'web-1'], [2, 'submit', 1, 'web-1'],
    [3, 'accept', 1, 'review-1'], [4, 'merged', 1, 'coordinator']]);
  const result = replayFlow(input);
  assert.deepEqual(result.replay.items, []);
  assert.deepEqual(result.replay.unmeasured.map(item => item.id), [1, 2]);
  assert.match(result.replay.unmeasured[0].reasons.join(' '), /review boundary/u);
  assert.deepEqual(result.replay.stages.build, { count: 0, fastQuarterMinutes: null, medianMinutes: null, slowQuarterMinutes: null, worstMinutes: null });
});

test('recorded landing ties follow event order and hypothetical WIP does not manufacture seats [R1,R2]', () => {
  const input = events([[0, 'add', 1, 'coordinator'], [0, 'add', 2, 'coordinator'],
    [0, 'claim', 1, 'web-1'], [0, 'claim', 2, 'web-2'], [1, 'submit', 1, 'web-1'], [1, 'submit', 2, 'web-2'],
    [1, 'reserve', 2, 'review-1'], [2, 'accept', 2, 'review-1'], [2, 'reserve', 1, 'review-1'],
    [3, 'accept', 1, 'review-1'], [5, 'merged', 2, 'coordinator'], [5, 'merged', 1, 'coordinator']]);
  assert.deepEqual(replayFlow(input).replay.landingOrder, [2, 1]);
  const changed = replayFlow(input, { order: [1, 2], settings: { wipPerReviewer: 2 } });
  assert.equal(changed.replay.items.find(item => item.id === 2).stages.reviewWait, 1,
    'the one observed reviewer still reviews one item at a time even when global review WIP is two');
});

test('replay refuses invalid limits, unknown item priorities and malformed structural history [R1,R2,A1]', () => {
  for (const policy of [{ order: [1, 1] }, { order: [999] }, { settings: { reviewWip: 0 } },
    { settings: { buildWip: 1.5 } }, { settings: { gateSlots: 10 } }, { extra: true }]) {
    assert.throws(() => replayFlow(rework(), policy), /USAGE/u);
  }
  const invalid = rework();
  invalid[0] = { event_id: 1, event_at: 'not a timestamp', event_kind: 'add', item_id: 1, event_by: 'coordinator' };
  assert.throws(() => replayFlow(invalid), /USAGE/u);
});


test('show retains its boolean history flag while flow accepts a history file [R1,A1]', async () => {
  let out = '', err = '';
  const code = await main(['help', 'show', '--history'], { stdout: { isTTY: false, write: text => { out += text; } },
    stderr: { write: text => { err += text; } } });
  assert.equal(code, 0, err);
  assert.match(out, /--history/u);
});


test('a clock rollback refuses replay instead of silently reordering native history [R1,R2]', () => {
  const input = rework();
  input[1].event_at = new Date(BASE - 60_000).toISOString();
  assert.throws(() => replayFlow(input), /clocks moved backwards in native event order/u);
  assert.throws(() => replayFlow([...input].reverse(), { order: [1] }), /clocks moved backwards/u,
    'array order cannot hide rollback by placing lower timestamps first');
});


/** Public board control names are replay inputs; internal stage capacities are not a second settings API. */
test('replay accepts modelled board controls and explicitly refuses unmodelled controls [R1,R2,A1]', () => {
  const settings = { reviewsFirst: true, wipPerReviewer: 1.5, landingBatchSize: 2, landingCadenceMinutes: 5 };
  const result = replayFlow(rework(), { settings });
  assert.equal(result.replay.mode, 'predicted');
  assert.deepEqual(result.replay.policy.settings, settings);
  assert.equal(result.replay.items[0].cycleMinutes, 10, 'recorded work is retained while observed queue waits are not imposed');
  assert.deepEqual(result.replay.items[0].stages,
    { build: 5, reviewWait: 0, review: 3, sendBackIdle: 0, mergeWait: 2 });
  for (const key of ['barReady', 'takeoverMinutes', 'reworkSameFamily']) {
    for (const value of [false, key === 'barReady' ? true : 30]) {
      assert.throws(() => replayFlow(rework(), { settings: { [key]: value } }),
        new RegExp(key + '.*not modelled by replay', 'u'), 'unknown authority is never silently ignored');
    }
  }
  for (const key of ['buildWip', 'reviewWip', 'landingWip']) {
    assert.throws(() => replayFlow(rework(), { settings: { [key]: 2 } }), /USAGE/u,
      'internal limits are not accepted as public board settings');
  }
});


/** Build canonical public lifecycle rows from independently specified recorded stage boundaries. */
function parallelHistory() {
  const rows = [];
  for (let id = 1; id <= 4; id += 1) {
    rows.push([0, 'add', id, 'coordinator'], [0, 'claim', id, `builder-${id}`],
      [4, 'submit', id, `builder-${id}`], [3 + id, 'reserve', id, 'reviewer'],
      [4 + id, 'accept', id, 'reviewer'], [9, 'merged', id, 'coordinator']);
  }
  return rows.sort((a, b) => a[0] - b[0]).map(([minute, kind, item, by], index) =>
    ({ event_id: index + 1, event_at: new Date(BASE + minute * 60_000).toISOString(), event_kind: kind, item_id: item, event_by: by }));
}

test('the shared total WIP cap retains fractional limits without manufacturing stage capacity [R1,R2]', () => {
  const input = parallelHistory();
  const low = replayFlow(input, { settings: { wipPerReviewer: 1.5 } });
  const high = replayFlow(input, { settings: { wipPerReviewer: 3 } });
  assert.deepEqual(low.replay.items.map(item => item.claimAt), [0, 5, 10, 15].map(minute => new Date(BASE + minute * 60_000).toISOString()),
    'ratio1.5 with one reviewer admits one total item until its verdict, not two builders plus reviews');
  assert.equal(high.replay.items[2].claimAt, new Date(BASE).toISOString());
  for (const result of [low, high]) {
    assert.equal(result.replay.stages.build.medianMinutes, 4);
    assert.equal(result.replay.stages.review.medianMinutes, 1);
  }
});

test('board replay controls validate their named ranges and keep off values explicit [R1,R2,A1]', () => {
  for (const [key, values] of Object.entries({ wipPerReviewer: [1, 3.1, '2'],
    landingBatchSize: [0, 9, 1.5], landingCadenceMinutes: [4, 31, 5.5], reviewsFirst: [1, 'true'] })) {
    for (const value of values) assert.throws(() => replayFlow(rework(), { settings: { [key]: value } }), /USAGE/u);
  }
  const settings = { reviewsFirst: false, wipPerReviewer: false, landingBatchSize: false, landingCadenceMinutes: false };
  assert.deepEqual(replayFlow(rework(), { settings }).replay.policy.settings, settings);
});


test('reviews-first changes a shared seat only above the native submitted threshold [R1,R2]', () => {
  const rows = [];
  for (let id = 1; id <= 4; id += 1) rows.push([0, 'add', id, 'coordinator'], [0, 'claim', id, `builder-${id}`],
    [1, 'submit', id, `builder-${id}`], [id, 'reserve', id, 'shared'], [id + 1, 'accept', id, 'shared'],
    [id + 2, 'merged', id, 'coordinator']);
  rows.push([1, 'add', 5, 'coordinator'], [5, 'claim', 5, 'shared'], [6, 'submit', 5, 'shared'],
    [6, 'reserve', 5, 'reviewer'], [7, 'accept', 5, 'reviewer'], [8, 'merged', 5, 'coordinator']);
  const input = events(rows.sort((a, b) => a[0] - b[0]));
  const buildsFirst = replayFlow(input, { order: [5, 1, 2, 3, 4], settings: { reviewsFirst: false } });
  const reviewsFirst = replayFlow(input, { order: [5, 1, 2, 3, 4], settings: { reviewsFirst: true } });
  assert.equal(buildsFirst.replay.items[0].stages.reviewWait, 2,
    'the prioritized item5 uses the one observed review slot at minute2; item1 then starts at3 after submitting at1');
  assert.equal(reviewsFirst.replay.items[0].stages.reviewWait, 0,
    'four submitted items exceed the default3 threshold for one currently active reviewer');
  assert.equal(reviewsFirst.replay.items[4].claimAt, new Date(BASE + 2 * 60_000).toISOString(),
    'after one verdict leaves only3 submissions, the explicit build order resumes without preemption');
  const below = replayFlow(rework(), { settings: { reviewsFirst: true } });
  assert.equal(below.replay.items[0].cycleMinutes, 10, 'one submitted item does not trigger review priority');
});

test('landing cadence starts at actual admitted work when its recorded seat is busy [R1,R2]', () => {
  const rows = [[0, 'add', 1, 'coordinator'], [0, 'add', 2, 'coordinator'],
    [0, 'claim', 1, 'builder'], [0, 'claim', 2, 'coordinator'],
    [1, 'submit', 1, 'builder'], [6, 'submit', 2, 'coordinator'],
    [6, 'reserve', 1, 'reviewer'], [7, 'accept', 1, 'reviewer'], [7, 'reserve', 2, 'reviewer'],
    [8, 'accept', 2, 'reviewer'], [8, 'merged', 1, 'coordinator'], [9, 'merged', 2, 'coordinator']];
  const events = rows.map(([minute, kind, item, by], index) => ({ event_id: index + 1,
    event_at: new Date(BASE + minute * 60_000).toISOString(), event_kind: kind, item_id: item, event_by: by }));
  const result = replayFlow(events, { settings: { landingBatchSize: 1, landingCadenceMinutes: 5 } });
  assert.equal(result.replay.items[0].landedAt, new Date(BASE + 7 * 60_000).toISOString(),
    'the recorded one-minute landing interval starts only when the coordinator seat is free at minute six');
  assert.equal(result.replay.items[1].landedAt, new Date(BASE + 12 * 60_000).toISOString(),
    'the next batch waits for actual prior start plus cadence and prior completion');
});


test('active reviewers follow the moving simulated sixty-minute event window [R1,R2,H16]', () => {
  const rows = [];
  for (let id = 1; id <= 6; id += 1) {
    const start = id <= 2 ? 0 : 70;
    rows.push([start, 'add', id, 'coordinator'], [start, 'claim', id, `builder-${id}`],
      [start + 1, 'submit', id, `builder-${id}`], [start + 1, 'reserve', id, `reviewer-${id}`],
      [start + 2, 'accept', id, `reviewer-${id}`], [start + 3, 'merged', id, 'coordinator']);
  }
  const input = events(rows.sort((a, b) => a[0] - b[0]));
  const result = replayFlow(input, { settings: { wipPerReviewer: 2 } });
  assert.deepEqual(result.replay.items.map(item => item.claimAt), [0, 0, 70, 70, 71, 71].map(minute => atMinute(minute)),
    'future reviewers do not inflate admission; expired first-wave reviewers leave a minimum-one window until new reservations occur');
  assert.deepEqual(replayFlow([...input].reverse(), { settings: { wipPerReviewer: 2 } }), result);
});

/** Expected fixture instants are arithmetic on recorded minutes, never wall-clock samples. */
function atMinute(minute) { return new Date(BASE + minute * 60_000).toISOString(); }
