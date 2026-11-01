/** Where item time goes: every phase sums to each landed item's clock time, in a fixture with known events [R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TIME_PHASES } from '../packages/stats/index.js';
import { checkpointLine } from '../packages/stats/index.js';
import { timeLines } from '../packages/stats/index.js';
import { timeStats } from '../packages/stats/index.js';
import { weeklyDue } from '../packages/stats/index.js';
import { proofFields } from '../packages/verify/index.js';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const MIN = 60000;
let id = 0;
/** One native event at a known minute offset. */
const ev = (item, minute, kind, detail = {}) => ({ event_id: ++id, item_id: item, event_kind: kind, event_at: new Date(T0 + minute * MIN).toISOString(), event_detail: JSON.stringify(detail) });

/** Item 1: one clean pass. Item 2: a reject cycle and an idle hold, with recorded gate and seat time. */
const HISTORY = [
  ev(1, 0, 'add'), ev(1, 10, 'claim'), ev(1, 40, 'submit'), ev(1, 50, 'reserve'), ev(1, 60, 'accept'), ev(1, 65, 'merged'),
  ev(2, 0, 'add'), ev(2, 5, 'claim'), ev(2, 15, 'fact', { kind: 'seat-time', toolMs: 4 * MIN, thinkingMs: 2 * MIN }),
  ev(2, 20, 'release'), ev(2, 30, 'claim'),
  ev(2, 50, 'submit', { gatePhases: { static: MIN, doctrine: 2 * MIN, check: 3 * MIN, test: 4 * MIN, conflict: 0 } }),
  ev(2, 60, 'reserve'), ev(2, 70, 'reject'), ev(2, 80, 'claim'), ev(2, 95, 'submit'), ev(2, 100, 'reserve'), ev(2, 110, 'accept'), ev(2, 120, 'merged'),
];
const NOW = T0 + 200 * MIN;

test('every phase sums to each landed item clock time [R1,R2,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  assert.equal(stats.landed, 2);
  for (const item of stats.items) {
    const sum = TIME_PHASES.reduce((total, phase) => total + item.phases[phase], 0);
    assert.equal(sum, item.clockMs, `item ${item.id} phases sum to its clock time`);
  }
  assert.deepEqual(stats.items.map(item => item.clockMs / MIN), [65, 120]);
});

test('queued, building, review and landing minutes match the known events [R1,R2,C7]', () => {
  const [one, two] = timeStats(HISTORY, { now: NOW, days: 7 }).items;
  assert.deepEqual([one.phases.queued, one.phases.building, one.phases.reviewWait, one.phases.reviewing, one.phases.landing].map(ms => ms / MIN), [10, 30, 10, 10, 5]);
  assert.equal(two.phases.idleHold / MIN, 10, 'release to the next claim is an idle hold');
  assert.equal(two.phases.rejectWaitingBuilder / MIN, 10, 'reject to the next claim waits for the builder');
  assert.equal(two.phases.rejectRebuilding / MIN, 15, 'the next claim to submit rebuilds');
});

test('recorded gate phases and seat time split building without changing the total [R1,R2,C7]', () => {
  const [, two] = timeStats(HISTORY, { now: NOW, days: 7 }).items;
  assert.deepEqual(['static', 'doctrine', 'check', 'test', 'conflict'].map(phase => two.phases[phase] / MIN), [1, 2, 3, 4, 0]);
  assert.equal(two.phases.tool / MIN, 4);
  assert.equal(two.phases.thinking / MIN, 2);
});

test('medians and totals cover the window and drop items that landed outside it [R1,R2,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  assert.equal(stats.phases.queued.totalMs / MIN, 15);
  assert.equal(stats.phases.queued.medianMs / MIN, 7.5);
  assert.equal(timeStats(HISTORY, { now: NOW + 8 * 86400000, days: 7 }).landed, 0);
  assert.ok(timeLines(stats).length > 3);
});

test('a checkpoint is one dated JSON line and a weekly one is due only after seven days [R1,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  const line = checkpointLine(stats, { reason: 'weekly' });
  assert.equal(JSON.parse(line).landed, 2);
  assert.equal(weeklyDue('', NOW), true);
  assert.equal(weeklyDue(`${line}\n`, NOW + 6 * 86400000), false);
  assert.equal(weeklyDue(`${line}\n`, NOW + 7 * 86400000), true);
});

test('a production check receipt of 60000 ms shows as 60000 ms of check time, not a matching sum [R1,R2,C7]', () => {
  const proof = { item: 3, frozenDigest: null, environment: null, seat: 'core-1', runner: null, exitCode: 0,
    counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: 60000, sourceClean: true };
  assert.ok(proofFields(proof), 'the production validator accepts these receipt fields');
  const receipt = { id: '11111111-1111-4111-8111-111111111111', kind: 'check', at: new Date(T0 + 8 * MIN).toISOString(), ...proof };
  const history = [ev(3, 0, 'add'), ev(3, 1, 'claim'), ev(3, 8, 'proof-run', { receipt }), ev(3, 10, 'submit'),
    ev(3, 12, 'reserve'), ev(3, 14, 'accept'), ev(3, 15, 'merged')];
  const stats = timeStats(history, { now: T0 + 200 * MIN, days: 7 });
  assert.equal(stats.phases.check.totalMs, 60000);
  assert.equal(stats.phases.building.totalMs, 9 * MIN - 60000);
  assert.equal(stats.items[0].clockMs, 15 * MIN);
});

test('a native submit criterion receipt contributes check time [R1,R2,C7]', () => {
  const proof = proofFields({ item: 4, frozenDigest: null, environment: null, seat: 'core-1', runner: null,
    exitCode: 0, counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: MIN, sourceClean: true,
    submitPhase: 'criterion', submitAdmission: '11111111-1111-4111-8111-111111111111' });
  assert.ok(proof);
  const history = [ev(4, 0, 'add'), ev(4, 1, 'claim'), ev(4, 3, 'proof-run', { receipt: { id: '22222222-2222-4222-8222-222222222222', kind: 'submit', ...proof } }),
    ev(4, 4, 'submit'), ev(4, 5, 'reserve'), ev(4, 6, 'accept'), ev(4, 7, 'merged')];
  const stats = timeStats(history, { now: NOW, days: 7 });
  assert.equal(stats.phases.check.totalMs, MIN);
  assert.equal(stats.items[0].clockMs, 7 * MIN);
});
