/** Two hand-computed windows use real Git/SQLite history; current rows intentionally disagree [R1,R2,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { compareFlowWindows } from '../../../../../stats/index.js';
import { BASE } from '../../../fixtures/stats/compare.js';
import { entries } from '../../../fixtures/stats/compare.js';
import { fixture } from '../../../fixtures/stats/compare.js';
import { idle } from '../../../fixtures/stats/compare.js';

test('store.logic-board-stats-compare.absent-historical-reasons-stay-unknown-and: absent historical reasons stay unknown and incomplete windows never pretend measured zero [R2]', t => {
  const box = fixture(t, entries().filter(row => row[2] !== 'next-idle'));
  const result = compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  assert.equal(result.previous.idleReasons.unknown, 72 / 120);
  assert.equal(result.current.idleReasons.unknown, 90 / 120);
  for (const window of [result.current, result.previous]) {
    for (const reason of ['nothing-eligible', 'held', 'review-family', 'main-red', 'focus']) assert.equal(window.idleReasons[reason], 0);
  }
  assert.equal(compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60 }).available, false);
  const empty = compareFlowWindows([], { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  for (const key of ['agentHoursPerLanding', 'rejectRate', 'submitsPerItem', 'shoutsPerLanding', 'idleShare']) assert.equal(empty.current[key], null, key);
});

test('store.logic-board-stats-compare.focus-idle-observations-are-counted-as: focus idle observations are counted as focus time [B26,R2]', t => {
  const changes = entries().map(entry => entry[2] === 'next-idle' && entry[4]?.reason === 'review-family'
    ? [...entry.slice(0, 4), idle('focus')] : entry);
  const box = fixture(t, changes);
  const result = compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  assert.equal(result.previous.idleReasonHours.focus, 20 / 60);
  assert.equal(result.previous.idleReasons.focus, 20 / 120);
});

test('store.logic-board-stats-compare.next-records-an-authenticated-prospective-cause: next records an authenticated prospective cause and refuses an invented reason without an event [R2,N2]', t => {
  const box = fixture(t, []);
  const before = box.history().length;
  assert.deepEqual(store.board_recordNextIdle(box.board, { agentId: 'core-1', reason: 'held' }), { recorded: true });
  const event = box.history().at(-1);
  assert.equal(event.event_kind, 'next-idle');
  assert.equal(event.event_by, 'core-1');
  assert.deepEqual(JSON.parse(event.event_detail), { ...idle('held'), model: 'unknown' });
  assert.equal(box.history().length, before + 1);
  assert.throws(() => store.board_recordNextIdle(box.board, { agentId: 'core-1', reason: 'guessed-old-history' }), error => error.code === 'BAD_IDLE_REASON');
  assert.throws(() => store.board_recordNextIdle(box.board, { agentId: 'missing', reason: 'held' }), error => error.code === 'NOT_JOINED');
  assert.equal(box.history().length, before + 1);
  assert.deepEqual(store.board_recordNextIdle(box.board, { agentId: 'core-1', reason: 'held' }), { recorded: true, unchanged: true });
});


test('store.logic-board-stats-compare.next-diagnostics-preserve-default-query-shapes: next diagnostics preserve default query shapes and report only actually encountered held work [R2,N2]', t => {
  const box = fixture(t, []);
  const normal = store.nextFor(box.board, { agentId: 'core-1', lane: 'core' });
  assert.equal(normal.item.item_id, 1);
  assert.equal(Object.hasOwn(normal, 'idleReason'), false);
  store.holdLane(box.board, 'core', { agentId: 'coordinator', reason: 'explicit fixture hold' });
  const old = store.nextFor(box.board, { agentId: 'core-1', lane: 'core' });
  const observed = store.nextFor(box.board, { agentId: 'core-1', lane: 'core', observeIdle: true });
  assert.equal(observed.idleReason, 'held');
  const { idleReason: ignored, ...unchanged } = observed;
  assert.deepEqual(unchanged, old, 'observation does not change eligibility or historical return shape');
});


