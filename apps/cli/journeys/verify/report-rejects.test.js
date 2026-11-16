/** The daily review report classifies each reject and counts reservations lost mid-review [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rejectReport } from '../../../../packages/stats/index.js';
import { rejectLines } from '../../../../packages/stats/index.js';

const DAY = Date.parse('2026-11-10T00:00:00.000Z');
const MIN = 60_000;
/** Build board event rows at minute offsets into the seeded day. */
const seed = entries => entries.map(([minute, kind, item, detail = {}, by = 'core-2'], index) => ({
  event_id: index + 1, event_at: new Date(DAY + minute * MIN).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail),
}));
const WINDOW = { from: DAY, until: DAY + 24 * 60 * MIN };

test('clause 1: each reject is classified as clause unmet, new red, main drift, stale patch or lane/hold [C7]', () => {
  const history = seed([
    [10, 'reject', 1, { reason: 'BEHAVIOR_MISMATCH', clause: '2' }],
    [11, 'reject', 2, { reason: 'TEST_FAILURE' }],
    [12, 'reject', 3, { reason: 'TEST_FAILURE', pipelineCause: { type: 'main-red' } }],
    [13, 'reject', 4, { reason: 'STALE_HEAD' }],
    [14, 'reject', 5, { reason: 'OTHER', held: true }],
  ]);
  const { rejects, classes } = rejectReport(history, WINDOW);
  assert.deepEqual(rejects.map(r => [r.item, r.class]), [[1, 'clause unmet'], [2, 'new red'], [3, 'main drift'], [4, 'stale patch'], [5, 'lane/hold']]);
  assert.deepEqual(classes, { 'lane/hold': 1, 'stale patch': 1, 'main drift': 1, 'new red': 1, 'clause unmet': 1 });
  assert.match(rejectLines(rejectReport(history, WINDOW))[0], /^rejects lane\/hold: 1$/u);
});

test('clause 2: reservations lost mid-review are counted [C7]', () => {
  const until = minute => ({ until: new Date(DAY + minute * MIN).toISOString() });
  const history = seed([
    [10, 'reserve', 1, until(40)], [20, 'release', 1],
    [10, 'reserve', 2, until(40)], [15, 'reserve', 2, until(45), 'core-3'], [30, 'accept', 2],
    [10, 'reserve', 3, until(20)], [60, 'release', 3],
    [10, 'reserve', 4, until(40)], [25, 'reject', 4, { reason: 'TEST_FAILURE' }],
  ]);
  const { lostReservations } = rejectReport(history, WINDOW);
  assert.deepEqual(lostReservations.map(l => [l.item, l.how]), [[1, 'release'], [2, 'taken over'], [3, 'expired']]);
  assert.equal(rejectLines(rejectReport(history, WINDOW)).at(-1), 'reservations lost mid-review: 3');
});
