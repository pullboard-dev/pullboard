/** Hand-computed synthetic histories exercise real Git/SQLite statistics and each recommendation [R1,R2]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { flowLines } from '../../../../packages/stats/index.js';
import { flowStats } from '../../../../packages/stats/index.js';
import { prepareFlowHistory } from '../../../../packages/stats/index.js';
import { projectFlowStats } from '../../../../packages/stats/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


const BASE = Date.parse('2026-10-10T00:00:00Z');

/** Convert hand-written minute offsets to exact UTC timestamps. */
function at(minutes) { return new Date(BASE + minutes * 60_000).toISOString(); }

/** Import a synthetic native event log into a private on-disk SQLite board in a real Git repository.
 * Current item rows deliberately remain open: statistics must follow events, not those stale rows.
 */
function fixture(t, entries, now = 200) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-flow-'));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  const seed = openBoard(join(root, '.git', 'seed.sqlite'));
  store.register(seed, { lane: 'coordinator', path: root });
  for (let n = 1; n <= 8; n += 1) store.register(seed, { lane: 'core', path: join(root, `builder-${n}`) });
  for (let n = 1; n <= 2; n += 1) store.register(seed, { lane: 'review', path: join(root, `reviewer-${n}`) });
  const maxId = Math.max(0, ...entries.map(entry => entry[3] ?? 0));
  for (let id = 1; id <= maxId; id += 1) store.addItem(seed, { by: 'coordinator', lane: 'core', title: `Flow ${id}` });
  const document = exportBoard(seed);
  store.closeBoard(seed);
  const joins = document.tables.agent.map(agent => [0, agent.agent_id, 'join', null, { lane: agent.agent_lane }]);
  document.tables.event = [...joins, ...entries].map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry[0] - b.entry[0] || a.order - b.order)
    .map(({ entry: [minutes, by, kind, item, detail = {}] }, index) => ({
      event_id: index + 1, event_at: at(minutes), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail),
    }));
  document.tables.sqlite_sequence.find(row => row.name === 'event').seq = document.tables.event.length;
  const board = openBoard(join(root, '.git', 'flow.sqlite'));
  importBoard(board, document);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  /** Read the real board at its deterministic observation time. */
  function stats(options = {}) { return proofStats(board, { now: BASE + now * 60_000, ...options }, statsReadPorts); }
  return { board, stats };
}

/** Produce a valid single-attempt measured cycle with independently chosen four stage lengths. */
function cycle(id, durations, start = 1, { legacy = false } = {}) {
  const [build, wait, review, merge] = durations;
  const submitted = start + build, reserved = submitted + wait, accepted = reserved + review;
  const commit = String(id).repeat(40);
  return [
    [0, 'coordinator', 'add', id, { lane: 'core' }],
    [start, `core-${id}`, 'claim', id, { leaseUntil: at(1000) }],
    [submitted, `core-${id}`, 'submit', id, { commit }],
    ...(legacy ? [] : [[reserved, 'review-1', 'reserve', id, { until: at(1000) }]]),
    [accepted, 'review-1', 'accept', id, { commit }],
    [accepted + merge, 'coordinator', 'merged', id, { commit: 'a'.repeat(40) }],
  ];
}

/** Return the exact summary expected from hand-computed samples. */
function summary(count, totalMinutes, averageMinutes, medianMinutes, unmeasuredCompleted = 0) {
  return { count, totalMinutes, averageMinutes, medianMinutes, unmeasuredCompleted };
}

test('a flow window reports stage quartiles and the slowest items with their cause [R1,R2]', t => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  const entries = [
    ...cycle(1, [10, 20, 5, 10], 250), ...cycle(2, [20, 40, 10, 20], 250),
    ...cycle(3, [30, 60, 15, 30], 250), ...cycle(4, [40, 80, 20, 40], 250),
    ...cycle(5, [50, 60, 70, 80], 250, { legacy: true }),
    [0, 'coordinator', 'add', 6, { lane: 'core' }],
    [250, 'core-6', 'claim', 6, { leaseUntil: at(1000) }], [260, 'core-6', 'submit', 6, { commit: a }],
    [265, 'review-1', 'reserve', 6, { until: at(1000) }], [270, 'review-1', 'reject', 6, { commit: a }],
    [300, 'core-6', 'claim', 6, { leaseUntil: at(1000) }], [320, 'core-6', 'submit', 6, { commit: b }],
    [330, 'review-1', 'reserve', 6, { until: at(1000) }], [340, 'review-1', 'reject', 6, { commit: b }],
    [350, 'core-6', 'claim', 6, { leaseUntil: at(1000) }], [380, 'core-6', 'submit', 6, { commit: c }],
    [400, 'review-1', 'reserve', 6, { until: at(1000) }], [420, 'review-1', 'accept', 6, { commit: c }],
    [500, 'coordinator', 'merged', 6],
    ...cycle(7, [1, 1, 1, 1], 1), [500, 'coordinator', 'merged', 7],
    ...cycle(8, [1, 1, 1, 1], 700),
    [100, 'coordinator', 'add', 9, { lane: 'core' }], [480, 'coordinator', 'merged', 9],
    [300, 'coordinator', 'add', 10, { lane: 'core' }],
  ];
  const { board, stats } = fixture(t, entries, 600);
  const history = store.events(board);
  const result = flowStats(history, null, BASE + 600 * 60_000, stats(), { windowMinutes: 360 });
  const window = result.window;
  assert.ok(window, 'the existing event-derived flow projection carries the requested window');
  assert.equal(window.since, at(240));
  assert.equal(window.until, at(600));
  assert.equal(window.landedItems, 7, 'include an incompletely recorded landing, but not future or repeated old receipts');
  assert.deepEqual(window.arrivals, { added: 1, landed: 7 });
  const { stages } = window;
  assert.deepEqual([stages.build.count, stages.build.fastQuarterMinutes, stages.build.medianMinutes,
    stages.build.slowQuarterMinutes, stages.build.worstMinutes, stages.build.unmeasuredCompleted], [6, 20, 35, 50, 60, 1]);
  assert.deepEqual([stages.reviewWait.count, stages.reviewWait.fastQuarterMinutes, stages.reviewWait.medianMinutes,
    stages.reviewWait.slowQuarterMinutes, stages.reviewWait.worstMinutes, stages.reviewWait.unmeasuredCompleted], [5, 35, 40, 60, 80, 2]);
  assert.equal(stages.reviewWait.overTargetMinutes, 95, 'sum each landed item\'s excess over the 30-minute target');
  assert.deepEqual(window.constraint, { stage: 'reviewWait', overTargetMinutes: 95 });
  assert.deepEqual(stages.reviewWait.tail.map(item => item.id), [4, 3, 2]);
  assert.equal(stages.reviewWait.tail[0].eligibility, 'unmeasured', 'waiting alone cannot establish reviewer ineligibility');
  assert.deepEqual(stages.build.tail.map(item => item.id), [6, 5, 4]);
  assert.equal(stages.build.tail[0].cause, 'rework');
  assert.equal(stages.build.tail[0].submissions, 3);
  assert.equal(stages.build.arrivals, 8);
  assert.equal(stages.build.completions, 8);
  assert.deepEqual(stages.build.seats, ['core-1', 'core-2', 'core-3', 'core-4', 'core-5', 'core-6']);
  assert.deepEqual([stages.sendBackIdle.count, stages.sendBackIdle.medianMinutes, stages.sendBackIdle.unmeasuredCompleted], [1, 40, 6]);
  assert.equal(stages.sendBackIdle.tail[0].cause, 'send-back-idle');
  assert.deepEqual(stages.mergeWait.tail.map(item => item.id), [5, 6, 4], 'equal tail durations use ascending item id');
  assert.equal(stages.mergeWait.tail[0].cause, 'landing-queue');
  assert.deepEqual(store.events(board), history, 'statistics append no synthetic measurement moves');
});

test('flow windows retain released reviews, lease boundaries and repeated accept evidence [R1,R2]', t => {
  const commit = 'a'.repeat(40);
  const { board, stats } = fixture(t, [
    [0, 'coordinator', 'add', 1, { lane: 'core' }],
    [10, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [20, 'core-1', 'submit', 1, { commit }],
    [30, 'review-1', 'reserve', 1, { until: at(35) }],
    [40, 'review-2', 'reserve', 1, { until: at(50) }],
    [50, 'review-2', 'release', 1, { review: true }],
    [60, 'review-1', 'reserve', 1, { until: at(70) }],
    [70, 'review-1', 'accept', 1, { commit }],
    [80, 'review-1', 'accept', 1, { commit }],
    [90, 'coordinator', 'merged', 1],
    [0, 'coordinator', 'add', 2, { lane: 'core' }],
    [10, 'core-2', 'claim', 2, { leaseUntil: at(25) }],
    [0, 'coordinator', 'add', 3, { lane: 'core' }],
    [10, 'core-3', 'claim', 3, { leaseUntil: at(1000) }],
    [20, 'core-3', 'submit', 3, { commit }],
    [30, 'review-2', 'reserve', 3, { until: at(40) }],
  ], 100);
  const history = store.events(board);
  const prepared = prepareFlowHistory(history, { window: true });
  const before = JSON.stringify(prepared);
  const window = projectFlowStats(prepared, null, BASE + 100 * 60_000, stats(), { windowMinutes: 100 }).window;
  assert.equal(window.landedItems, 1);
  assert.equal(window.stages.build.medianMinutes, 10);
  assert.equal(window.stages.reviewWait.medianMinutes, 25, 'wait is 20-30 plus 35-40 plus 50-60');
  assert.equal(window.stages.review.medianMinutes, 25, 'review ends at recorded expiry or release; a verdict at expiry remains valid');
  assert.equal(window.stages.mergeWait.medianMinutes, 20, 'repeated acceptance cannot erase the first acceptance');
  assert.deepEqual(window.stages.review.seats, ['review-1', 'review-2']);
  assert.equal(window.stages.review.completions, 4, 'includes the still-submitted item reservation expiry');
  assert.equal(window.stages.build.completions, 3, 'includes a claim expiring without another move');
  assert.equal(window.stages.reviewWait.arrivals, 5, 'includes observed waiting after expiry');
  assert.equal(JSON.stringify(prepared), before, 'time-specific expiry observation does not mutate reusable history');
  assert.deepEqual(store.events(board), history);
});

test('flow windows leave missing starts and empty distributions unmeasured [R1,R2]', t => {
  const commit = 'a'.repeat(40);
  const { board, stats } = fixture(t, [
    [0, 'coordinator', 'add', 1, { lane: 'core' }],
    [10, 'core-1', 'submit', 1, { commit }],
    [20, 'review-1', 'reject', 1, { commit }],
    [30, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [40, 'core-1', 'submit', 1, { commit: 'b'.repeat(40) }],
    [50, 'review-1', 'reserve', 1, { until: at(1000) }],
    [60, 'review-1', 'accept', 1, { commit: 'b'.repeat(40) }],
    [70, 'coordinator', 'merged', 1],
  ], 100);
  const history = store.events(board);
  const window = flowStats(history, null, BASE + 100 * 60_000, stats(), { windowMinutes: 100 }).window;
  assert.equal(window.stages.build.count, 0, 'one measured rework cannot fill a missing original start');
  assert.equal(window.stages.build.medianMinutes, null);
  assert.equal(window.stages.reviewWait.count, 0, 'an unreserved original verdict leaves the whole item total incomplete');
  assert.equal(window.stages.reviewWait.arrivals, 2, 'a missing close cannot erase a known arrival');
  assert.equal(window.stages.sendBackIdle.medianMinutes, 10);
  const empty = flowStats(history, null, BASE + 100 * 60_000, stats(), { windowMinutes: 10 }).window;
  assert.equal(empty.landedItems, 0);
  assert.equal(empty.stages.build.count, 0);
  assert.equal(empty.stages.build.worstMinutes, null);
  assert.deepEqual(empty.stages.build.tail, []);
  assert.deepEqual(empty.constraint, { stage: null, overTargetMinutes: 0 });
});

test('flow windows retain recorded idle after reopen and builder release [R1,R2]', t => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const { board, stats } = fixture(t, [
    [0, 'coordinator', 'add', 1, { lane: 'core' }],
    [10, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [20, 'core-1', 'submit', 1, { commit: a }],
    [30, 'review-1', 'reserve', 1, { until: at(1000) }],
    [40, 'review-1', 'accept', 1, { commit: a }],
    [50, 'coordinator', 'reopen', 1],
    [80, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [90, 'core-1', 'submit', 1, { commit: b }],
    [100, 'review-1', 'reserve', 1, { until: at(1000) }],
    [110, 'review-1', 'accept', 1, { commit: b }],
    [120, 'coordinator', 'merged', 1],
    [0, 'coordinator', 'add', 2, { lane: 'core' }],
    [10, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [20, 'core-2', 'release', 2],
    [60, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [70, 'core-2', 'submit', 2, { commit: a }],
    [80, 'review-1', 'reserve', 2, { until: at(1000) }],
    [90, 'review-1', 'reject', 2, { commit: a }],
    [100, 'coordinator', 'reopen', 2],
    [120, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [130, 'core-2', 'submit', 2, { commit: b }],
    [140, 'review-1', 'reserve', 2, { until: at(1000) }],
    [150, 'review-1', 'accept', 2, { commit: b }],
    [160, 'coordinator', 'merged', 2],
  ], 200);
  const window = flowStats(store.events(board), null, BASE + 200 * 60_000, stats(), { windowMinutes: 200 }).window;
  assert.equal(window.stages.sendBackIdle.count, 2, 'every recorded return-to-work has a measured idle interval');
  assert.equal(window.stages.sendBackIdle.totalMinutes, 100, '30 reopened plus 40 released plus 30 rejected/reopened');
  assert.deepEqual(window.stages.sendBackIdle.tail.map(row => [row.id, row.minutes]), [[2, 70], [1, 30]]);
  assert.equal(window.stages.sendBackIdle.arrivals, 3, 'a repeated open move does not invent another arrival');
  assert.equal(window.stages.sendBackIdle.completions, 3);
  assert.equal(window.stages.build.totalMinutes, 50, 'released building work remains measured');
});

test('flow windows never substitute a merge receipt for an unrecorded stage end [R1,R2]', t => {
  const commit = 'a'.repeat(40);
  const { board, stats } = fixture(t, [
    [0, 'coordinator', 'add', 1, { lane: 'core' }],
    [10, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [50, 'coordinator', 'merged', 1],
    [0, 'coordinator', 'add', 2, { lane: 'core' }],
    [10, 'core-2', 'submit', 2, { commit }],
    [50, 'coordinator', 'merged', 2],
    [0, 'coordinator', 'add', 3, { lane: 'core' }],
    [0, 'core-3', 'claim', 3, { leaseUntil: at(1000) }],
    [10, 'core-3', 'submit', 3, { commit }],
    [20, 'review-1', 'reserve', 3, { until: at(1000) }],
    [50, 'coordinator', 'merged', 3],
    [0, 'coordinator', 'add', 4, { lane: 'core' }],
    [0, 'core-4', 'claim', 4, { leaseUntil: at(1000) }],
    [10, 'core-4', 'submit', 4, { commit }],
    [20, 'review-1', 'reserve', 4, { until: at(1000) }],
    [30, 'review-1', 'reject', 4, { commit }],
    [50, 'coordinator', 'merged', 4],
  ], 100);
  const window = flowStats(store.events(board), null, BASE + 100 * 60_000, stats(), { windowMinutes: 100 }).window;
  assert.equal(window.stages.build.count, 2, 'a merge without a submit cannot finish building');
  assert.equal(window.stages.reviewWait.count, 2, 'a merge without a reservation cannot finish waiting');
  assert.equal(window.stages.review.count, 1, 'a merge without a verdict cannot finish reviewing');
  assert.equal(window.stages.sendBackIdle.count, 0, 'a merge without a reclaim cannot finish sent-back idle');
  assert.equal(window.stages.mergeWait.count, 0, 'no acceptance-to-landing interval was recorded');
});

test('flow numbers match a hand computation through rework, released reviews and every live queue [R1,R2]', t => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  const entries = [
    [0, 'coordinator', 'add', 1, { lane: 'core' }], [10, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [30, 'core-1', 'submit', 1, { commit: a }], [40, 'review-1', 'reserve', 1, { until: at(1000) }],
    [50, 'review-1', 'reject', 1, { commit: a }], [60, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [90, 'core-1', 'submit', 1, { commit: b }], [95, 'review-1', 'reserve', 1, { until: at(1000) }],
    [100, 'review-1', 'release', 1, { review: true }], [120, 'review-2', 'reserve', 1, { until: at(1000) }],
    [130, 'review-2', 'accept', 1, { commit: b }], [150, 'coordinator', 'merged', 1, { commit: c }],
    [170, 'coordinator', 'merged', 1, { commit: c }],
    [5, 'coordinator', 'add', 2, { lane: 'core' }], [20, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [60, 'core-2', 'submit', 2, { commit: a }], [70, 'review-1', 'reserve', 2, { until: at(1000) }],
    [100, 'review-1', 'accept', 2, { commit: a }], [160, 'coordinator', 'merged', 2, { commit: c }],
    [40, 'coordinator', 'add', 3, { lane: 'core' }],
    [100, 'coordinator', 'add', 4, { lane: 'core' }], [180, 'core-4', 'claim', 4, { leaseUntil: at(1000) }],
    [190, 'core-4', 'release', 4],
    [80, 'coordinator', 'add', 5, { lane: 'web' }], [100, 'core-5', 'claim', 5, { leaseUntil: at(180) }],
    [120, 'coordinator', 'add', 6, { lane: 'core' }], [175, 'core-6', 'claim', 6, { leaseUntil: at(220) }],
    [195, 'core-6', 'renew', 6, { leaseUntil: at(260) }],
    [150, 'coordinator', 'add', 7, { lane: 'core' }], [180, 'core-7', 'claim', 7, { leaseUntil: at(1000) }],
    [190, 'core-7', 'submit', 7, { commit: a }],
    [150, 'coordinator', 'add', 8, { lane: 'core' }], [180, 'core-8', 'claim', 8, { leaseUntil: at(1000) }],
    [185, 'core-8', 'submit', 8, { commit: a }], [190, 'review-1', 'reserve', 8, { until: at(1000) }],
    [195, 'review-1', 'accept', 8, { commit: a }], [199, 'core-7', 'shout', null],
  ];
  const { board, stats } = fixture(t, entries);
  const result = stats();
  assert.ok(result.flow, 'stats JSON carries event-derived flow');
  assert.equal(result.flow.asOf, at(200), 'all queue ages use this one recorded observation');
  assert.equal(store.getItem(board, 1).item_status, 'open', 'fixture rows cannot substitute for the event history');
  assert.deepEqual(result.flow.stages, {
    build: summary(4, 135, 33.75, 25),
    reviewWait: summary(3, 45, 15, 10),
    review: summary(3, 45, 15, 10),
    mergeWait: summary(2, 80, 40, 40),
  }, 'build samples80,40,10,5; wait30,10,5; review10,30,5; merge20,60');
  assert.deepEqual(result.flow.queues, {
    open: { size: 3, oldest: { id: 3, since: at(40), ageMinutes: 160 } }, claimed: { size: 1, oldest: { id: 6, since: at(175), ageMinutes: 25 } },
    submitted: { size: 1, oldest: { id: 7, since: at(190), ageMinutes: 10 } }, accepted: { size: 1, oldest: { id: 8, since: at(195), ageMinutes: 5 } },
  });
  assert.deepEqual(result.flow.daily, [{ date: '2026-10-10', added: 8, merged: 2 }]);
  assert.equal(result.flow.submitsPerMerged, 2.5, 'five submissions divided by two first merges');
  assert.equal(result.rejectionShare, 1 / 5);
  assert.deepEqual(result.flow.activeAgents, {
    total: 5, roles: { builder: 4, verifier: 1, coordinator: 0, unknown: 0 }, lanes: { core: 4, review: 1 },
    agents: ['core-4', 'core-6', 'core-7', 'core-8', 'review-1'].map(id => ({
      id, lane: id.startsWith('core') ? 'core' : 'review',
      role: id.startsWith('core') ? 'builder' : 'verifier',
    })),
  });
  assert.equal(result.flow.bottleneck.stage, 'build');
  assert.equal(result.flow.bottleneck.share, 120 / 280);
  assert.equal(result.flow.bottleneck.totalCycleMinutes, 280);
  assert.equal(result.flow.bottleneck.recommendation, 'add a builder in core');
  assert.deepEqual(result.flow.bottleneck.completedItems, 2);
  assert.deepEqual(flowLines(result.flow), [
    'build: average 34 min · median 25 min · 4 measured; 0 of 2 completed items unmeasured',
    'review wait: average 15 min · median 10 min · 3 measured; 0 of 2 completed items unmeasured',
    'review: average 15 min · median 10 min · 3 measured; 0 of 2 completed items unmeasured',
    'merge wait: average 40 min · median 40 min · 2 measured; 0 of 2 completed items unmeasured',
    'open queue: 3 · oldest #3 (2 h 40 min)', 'claimed queue: 1 · oldest #6 (25 min)',
    'submitted queue: 1 · oldest #7 (10 min)', 'accepted queue: 1 · oldest #8 (5 min)',
    'per day: 2026-10-10: 8 added, 2 merged', '2.5 submissions per merged item',
    'active in the last hour: 5 agents · roles builder 4, verifier 1, coordinator 0, unknown 0 · lanes core 4, review 1',
    'bottleneck: build has the largest share of cycle time; bottleneck from 2 fully measured cycles of 2 (42.86%)',
    'next: add a builder in core',
  ]);
  const before = store.events(board);
  stats();
  assert.deepEqual(store.events(board), before, 'reading flow never records a move');

  const window = stats({ since: at(150) });
  assert.deepEqual(window.flow.stages.build, summary(2, 15, 7.5, 7.5));
  assert.deepEqual(window.flow.stages.mergeWait, summary(2, 80, 40, 40));
  assert.equal(window.flow.bottleneck.share, 120 / 280, 'completed cycles retain their pre-window stages');
  assert.deepEqual(window.flow.daily, [{ date: '2026-10-10', added: 2, merged: 2 }]);
  assert.equal(stats({ since: at(170) }).flow.bottleneck.completedItems, 0, 'a repeated receipt is not another completed cycle');
  assert.deepEqual(stats({ since: at(170) }).flow.daily, [], 'repeated receipts cannot inflate a later day or window');
});

test('flow charges an expired reservation to waiting and counts UTC days at their exact boundary [R1,R2]', t => {
  const commit = '1'.repeat(40);
  const entries = [
    [1430, 'coordinator', 'add', 1, { lane: 'core' }], [1431, 'core-1', 'claim', 1, { leaseUntil: at(2000) }],
    [1435, 'core-1', 'submit', 1, { commit }], [1436, 'review-1', 'reserve', 1, { until: at(1438) }],
    [1440, 'review-2', 'reserve', 1, { until: at(2000) }], [1443, 'review-2', 'accept', 1, { commit }],
    [1445, 'coordinator', 'merged', 1, { commit: 'a'.repeat(40) }],
    [1440, 'coordinator', 'add', 2, { lane: 'core' }], [1446, 'coordinator', 'merged', 1, { commit: 'b'.repeat(40) }],
  ];
  const { stats } = fixture(t, entries, 1450);
  assert.deepEqual(stats().flow.daily, [
    { date: '2026-10-10', added: 1, merged: 0 }, { date: '2026-10-11', added: 1, merged: 1 },
  ]);
  const flow = stats({ since: '2026-10-11' }).flow;
  assert.deepEqual(flow.stages.build, summary(0, 0, null, null));
  assert.deepEqual(flow.stages.reviewWait, summary(1, 5, 5, 5));
  assert.deepEqual(flow.stages.review, summary(1, 3, 3, 3));
  assert.deepEqual(flow.stages.mergeWait, summary(1, 2, 2, 2));
  assert.equal(flow.bottleneck.totalCycleMinutes, 14, 'the full cycle retains the four pre-window build minutes');
  assert.equal(flow.bottleneck.share, 5 / 14);
  assert.deepEqual(flow.daily, [{ date: '2026-10-11', added: 1, merged: 1 }]);
});

test('flow distinguishes expired and released reviews, open resets, legacy gaps and exact boundaries [R1,R2]', t => {
  const commit = '1'.repeat(40);
  const entries = [
    ...cycle(1, [10, 20, 5, 10]), ...cycle(2, [10, 90, 20, 10], 1, { legacy: true }),
    ...cycle(3, [10, 90, 20, 10], 1, { legacy: true }),
    [20, 'coordinator', 'add', 4, { lane: 'core' }], [30, 'core-4', 'claim', 4, { leaseUntil: at(1000) }],
    [40, 'core-4', 'submit', 4, { commit }], [45, 'review-1', 'reserve', 4, { until: at(50) }],
    [180, 'review-2', 'reserve', 4, { until: at(1000) }],
    [190, 'coordinator', 'reopen', 4, { commit }],
    [10, 'coordinator', 'add', 5, { lane: 'core' }], [110, 'core-5', 'claim', 5, { leaseUntil: at(1000) }],
    [120, 'core-5', 'submit', 5, { commit }], [140, 'review-2', 'reserve', 5, { until: at(1000) }],
    [150, 'review-2', 'reject', 5, { commit }],
    [139, 'core-1', 'shout', null], [140, 'core-2', 'shout', null], [200, 'core-3', 'shout', null],
    [150, 'core-6', 'shout', null], [199, 'core-4', 'shout', null], [150, 'core-5', 'shout', null],
  ];
  const { stats } = fixture(t, entries);
  const flow = stats().flow;
  assert.deepEqual(flow.queues.open, { size: 2, oldest: { id: 5, since: at(150), ageMinutes: 50 } });
  assert.deepEqual(flow.stages.reviewWait, summary(2, 40, 20, 20, 2), 'legacy review intervals are omitted; reopen has no closing reservation');
  assert.deepEqual(flow.stages.review, summary(2, 15, 7.5, 7.5, 2));
  assert.equal(flow.bottleneck.completedItems, 3);
  assert.equal(flow.bottleneck.fullyMeasuredCycles, 1);
  assert.equal(flow.bottleneck.lowConfidence, true);
  assert.equal(flow.bottleneck.stage, 'reviewWait', 'long legacy waits cannot manufacture a measured bottleneck');
  assert.equal(flow.bottleneck.share, 20 / 45);
  assert.match(flow.bottleneck.message, /1 fully measured cycles of 3/u);
  assert.deepEqual(flow.activeAgents.agents.filter(agent => agent.id.startsWith('core')), [
    { id: 'core-2', lane: 'core', role: 'builder' }, { id: 'core-3', lane: 'core', role: 'builder' },
    { id: 'core-4', lane: 'core', role: 'builder' }, { id: 'core-5', lane: 'core', role: 'builder' },
    { id: 'core-6', lane: 'core', role: 'unknown' },
  ], 'inclusive last-hour boundary, prior role fallback, roleless unknown and stale actor exclusion');
});

test('every bottleneck recommendation follows its documented rule and ties choose the earlier stage [R1,R2]', t => {
  for (const [durations, extras, expected] of [
    [[1, 20, 1, 1], [[190, 'core-1', 'shout', null]], 'add a verifier'],
    [[1, 20, 1, 1], [[190, 'review-1', 'shout', null]], 'review the oldest submission first (#2)'],
    [[1, 20, 1, 1], [[190, 'review-1', 'shout', null],
      [185, 'core-4', 'claim', 4, { leaseUntil: at(1000) }],
      [180, 'coordinator', 'add', 5, { lane: 'core' }], [185, 'core-5', 'claim', 5, { leaseUntil: at(1000) }],
      [180, 'coordinator', 'add', 6, { lane: 'core' }], [185, 'core-6', 'claim', 6, { leaseUntil: at(1000) }]], 'review the oldest submission first (#2)'],
    [[20, 1, 1, 1], [[185, 'review-1', 'reserve', 2, { until: at(1000) }], [190, 'review-1', 'reject', 2, { commit: '2'.repeat(40) }]], 'tighten criteria or briefs: 1 of 3 submissions were sent back'],
    [[20, 1, 1, 1], [], 'add a builder in core'],
    [[1, 1, 20, 1], [], 'reviews are slow (median 13 min): check how long the frozen checks take'],
    [[1, 1, 1, 20], [], 'land the accepted items: #3'],
    [[20, 20, 20, 20], [], 'add a builder in core'],
  ]) {
    const entries = [...cycle(1, durations),
      [100, 'coordinator', 'add', 2, { lane: 'core' }], [110, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
      [180, 'core-2', 'submit', 2, { commit: '2'.repeat(40) }],
      [110, 'coordinator', 'add', 3, { lane: 'core' }], [115, 'core-3', 'claim', 3, { leaseUntil: at(1000) }],
      [120, 'core-3', 'submit', 3, { commit: '3'.repeat(40) }],
      [125, 'review-2', 'reserve', 3, { until: at(1000) }], [130, 'review-2', 'accept', 3, { commit: '3'.repeat(40) }],
      [150, 'coordinator', 'add', 4, { lane: 'core' }], ...extras];
    const result = fixture(t, entries).stats();
    assert.equal(result.flow.bottleneck.recommendation, expected, durations.join(','));
  }
});

test('stats sentences read times in human units [R1,R2]', t => {
  for (const [review, expected] of [[42, '42 min'], [213.9, '3 h 34 min'], [5707.5, '3 d 23 h']]) {
    const entries = cycle(1, [1, 1, review, 1]);
    for (const entry of entries) {
      if (entry[4]?.leaseUntil) entry[4].leaseUntil = at(10_000);
      if (entry[4]?.until) entry[4].until = at(10_000);
    }
    const { stats } = fixture(t, entries, Math.ceil(review + 10));
    const flow = stats().flow;
    assert.equal(flow.stages.review.averageMinutes, review, 'JSON keeps measured numeric precision');
    assert.equal(flow.bottleneck.recommendation, `reviews are slow (median ${expected}): check how long the frozen checks take`);
    assert.ok(flowLines(flow).includes(`review: average ${expected} · median ${expected} · 1 measured; 0 of 1 completed items unmeasured`));
    assert.ok(flowLines(flow).includes(`next: ${flow.bottleneck.recommendation}`), 'text output uses the same rounded recommendation');
  }
  const empty = fixture(t, []).stats().flow;
  assert.ok(flowLines(empty).includes('build: average unmeasured · median unmeasured · 0 measured; 0 of 0 completed items unmeasured'));
});

test('a recommendation names at most three items [R1,R2]', t => {
  const accepted = Array.from({ length: 5 }, (_, index) => {
    const id = index + 1, start = index * 10, commit = String(id).repeat(40);
    return [
      [start, 'coordinator', 'add', id, { lane: 'core' }], [start + 1, `core-${id}`, 'claim', id, { leaseUntil: at(1000) }],
      [start + 2, `core-${id}`, 'submit', id, { commit }], [start + 3, 'review-1', 'reserve', id, { until: at(1000) }],
      [start + 4, 'review-1', 'accept', id, { commit }],
    ];
  }).flat();
  const entries = [...accepted, ...cycle(6, [1, 1, 1, 20], 60)];
  const flow = fixture(t, entries).stats().flow;
  assert.equal(flow.queues.accepted.size, 5, 'the five named recommendation targets remain genuinely accepted');
  assert.equal(flow.bottleneck.recommendation, 'land the accepted items: #1, #2, #3 +2 more');
});

test('a prepared flow projection matches fresh expiry and activity windows without mutation [R1,R2]', t => {
  const commit = 'a'.repeat(40);
  const entries = [
    [-30, 'activity-only', 'shout', null],
    [0, 'coordinator', 'add', 1, { lane: 'core' }], [10, 'core-1', 'claim', 1, { leaseUntil: at(30) }],
    [0, 'coordinator', 'add', 2, { lane: 'core' }], [10, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [20, 'core-2', 'submit', 2, { commit }], [21, 'review-1', 'reserve', 2, { until: at(30) }],
  ];
  const { board } = fixture(t, entries);
  const history = store.events(board);
  const counts = { submissions: 1, rejections: 0, rejectionShare: 0 };
  const prepared = prepareFlowHistory(history);
  const observe = minute => projectFlowStats(prepared, null, BASE + minute * 60_000, counts);
  const reference = minute => flowStats(history, null, BASE + minute * 60_000, counts);

  const beforeExpiry = observe(29);
  assert.deepEqual(beforeExpiry, reference(29));
  assert.equal(beforeExpiry.queues.claimed.size, 1);
  assert.equal(beforeExpiry.unreviewed.size, 0);
  assert.ok(beforeExpiry.activeAgents.agents.some(agent => agent.id === 'activity-only'));

  const atExpiry = observe(30);
  assert.deepEqual(atExpiry, reference(30));
  assert.equal(atExpiry.queues.claimed.size, 0, 'a claim expires at its exact lease deadline');
  assert.equal(atExpiry.queues.open.size, 1);
  assert.equal(atExpiry.unreviewed.size, 1, 'a reservation expires at its exact deadline');
  assert.ok(atExpiry.activeAgents.agents.some(agent => agent.id === 'activity-only'), 'the last-hour boundary is inclusive');

  const afterExpiry = observe(31);
  assert.deepEqual(afterExpiry, reference(31));
  assert.equal(afterExpiry.stages.reviewWait.count, 0, 'an expired reservation no longer closes the wait stage');
  assert.ok(!afterExpiry.activeAgents.agents.some(agent => agent.id === 'activity-only'), 'activity ages out after 60 minutes');
  assert.deepEqual(observe(30), atExpiry, 'a later projection cannot mutate the prepared snapshot');
  assert.deepEqual(observe(31), afterExpiry, 'repeating a projection yields the same time-specific result');
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.items) && Object.isFrozen(prepared.items[0]));
});

test('flow reports no evidence instead of inventing a bottleneck or missing review time [R1,R2]', t => {
  const empty = fixture(t, []).stats().flow;
  assert.equal(empty.bottleneck.stage, null);
  assert.equal(empty.bottleneck.recommendation, null);
  assert.equal(empty.submitsPerMerged, 0);
  assert.deepEqual(empty.stages.build, summary(0, 0, null, null));
  const legacy = fixture(t, cycle(1, [10, 20, 30, 40], 1, { legacy: true })).stats().flow;
  assert.equal(legacy.bottleneck.stage, null);
  assert.equal(legacy.bottleneck.recommendation, null);
  assert.match(legacy.bottleneck.message, /1 items completed.*none with every stage measured/u);
  assert.deepEqual(legacy.stages.review, summary(0, 0, null, null, 1));
  assert.deepEqual(legacy.stages.build, summary(1, 10, 10, 10));
  const half = fixture(t, [...cycle(1, [10, 20, 30, 40]), ...cycle(2, [10, 20, 30, 40], 1, { legacy: true })]).stats().flow;
  assert.equal(half.bottleneck.lowConfidence, false, 'exactly half fully measured is not below half');
});

test('open age restarts on each return and equal queue ages choose the lower id [R1,R2]', t => {
  const entries = [
    [0, 'coordinator', 'add', 1, { lane: 'core' }], [10, 'core-1', 'claim', 1, { leaseUntil: at(1000) }],
    [190, 'core-1', 'release', 1],
    [0, 'coordinator', 'add', 2, { lane: 'core' }], [10, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
    [180, 'core-2', 'submit', 2, { commit: '2'.repeat(40) }], [185, 'coordinator', 'reopen', 2],
    [0, 'coordinator', 'add', 3, { lane: 'core' }], [10, 'core-3', 'claim', 3, { leaseUntil: at(190) }],
  ];
  assert.deepEqual(fixture(t, entries).stats().flow.queues.open, { size: 3, oldest: { id: 2, since: at(185), ageMinutes: 15 } });
  assert.deepEqual(fixture(t, entries.filter(entry => entry[2] !== 'reopen'), 200).stats().flow.queues.open,
    { size: 2, oldest: { id: 1, since: at(190), ageMinutes: 10 } });
});

test('active lane counts preserve recorded names that also exist on Object.prototype [R1,R2]', t => {
  const entries = [[150, 'core-1', 'join', null, { lane: 'constructor' }], [160, 'core-1', 'shout', null]];
  assert.deepEqual(fixture(t, entries).stats().flow.activeAgents, {
    total: 1, agents: [{ id: 'core-1', lane: 'constructor', role: 'unknown' }],
    roles: { builder: 0, verifier: 0, coordinator: 0, unknown: 1 }, lanes: { constructor: 1 },
  });
});

test('recommendations name an empty target queue honestly and choose the busiest open lane [R1,R2]', t => {
  for (const [durations, action] of [
    [[20, 1, 1, 1], 'add a builder when open work is available'],
    [[1, 20, 1, 1], 'review the oldest submission first (none waiting)'],
    [[1, 1, 1, 20], 'land the accepted items (none waiting)'],
  ]) assert.equal(fixture(t, cycle(1, durations)).stats().flow.bottleneck.recommendation, action);
  const entries = [...cycle(1, [20, 1, 1, 1]),
    [150, 'coordinator', 'add', 2, { lane: 'core' }], [150, 'coordinator', 'add', 3, { lane: 'web' }],
    [150, 'coordinator', 'add', 4, { lane: 'web' }]];
  assert.equal(fixture(t, entries).stats().flow.bottleneck.recommendation, 'add a builder in web');
});

test('every queue age has one exact observation clock and its recorded origin [R1,R2]', t => {
  const { stats } = fixture(t, [
    [1, 'coordinator', 'add', 1, { lane: 'core' }],
    [2, 'coordinator', 'add', 2, { lane: 'core' }],
    [3, 'core-2', 'claim', 2, { leaseUntil: at(1000) }],
  ]);
  const first = stats({ now: BASE + 200 * 60_000 });
  const second = stats({ now: BASE + 200 * 60_000 + 129 });
  assert.equal(second.flow.asOf, '2026-10-10T03:20:00.129Z');
  for (const state of ['open', 'claimed']) {
    const a = first.flow.queues[state].oldest;
    const b = second.flow.queues[state].oldest;
    assert.equal(b.since, a.since, 'a later read retains the exact lifecycle origin');
    assert.equal(b.ageMinutes, (Date.parse(second.flow.asOf) - Date.parse(b.since)) / 60_000);
    assert.equal(a.ageMinutes, (Date.parse(first.flow.asOf) - Date.parse(a.since)) / 60_000);
    assert.equal(b.ageMinutes, a.ageMinutes + 129 / 60_000);
  }
});
