/** The daily review report has one row per review with queue wait, review time and outcome [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewRows } from '../../../../packages/stats/index.js';
import { reviewRowLines } from '../../../../packages/stats/index.js';

const DAY = Date.parse('2026-11-10T00:00:00.000Z');
const MIN = 60_000;
/** Build board event rows at minute offsets into the seeded day. */
const seed = entries => entries.map(([minute, kind, item, by = 'core-1'], index) => ({
  event_id: index + 1, event_at: new Date(DAY + minute * MIN).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: '{}',
}));

test('clause 1: a seeded day produces a report row per item with queue wait, review time and outcome [C7]', () => {
  const history = seed([
    [10, 'submit', 1], [25, 'reserve', 1, 'core-2'], [40, 'accept', 1, 'core-2'],
    [12, 'submit', 2], [30, 'reserve', 2, 'core-3'], [38, 'reject', 2, 'core-3'],
    [50, 'submit', 3], [55, 'reserve', 3, 'core-2'], [58, 'release', 3, 'core-2'],
    [100, 'submit', 4],
  ]);
  const { rows } = reviewRows(history, { from: DAY, until: DAY + 24 * 60 * MIN });
  const byItem = Object.fromEntries(rows.map(r => [r.item, r]));
  assert.deepEqual(rows.map(r => r.item).sort(), [1, 2, 3, 4]);
  assert.deepEqual([byItem[1].queueWaitMs, byItem[1].reviewMs, byItem[1].outcome], [15 * MIN, 15 * MIN, 'accepted']);
  assert.deepEqual([byItem[2].queueWaitMs, byItem[2].reviewMs, byItem[2].outcome], [18 * MIN, 8 * MIN, 'rejected']);
  assert.deepEqual([byItem[3].queueWaitMs, byItem[3].reviewMs, byItem[3].outcome], [5 * MIN, null, 'released']);
  assert.deepEqual([byItem[4].queueWaitMs, byItem[4].reviewMs, byItem[4].outcome], [null, null, 'pending']);
  assert.match(reviewRowLines({ rows })[3], /#4 attempt 1: queue wait unmeasured · review unmeasured · pending/u);
});

test('clause 1: a window excludes reviews that ended before it and keeps each re-review as its own attempt [C7]', () => {
  const history = seed([
    [10, 'submit', 1], [20, 'reserve', 1], [30, 'reject', 1],
    [40, 'submit', 1], [45, 'reserve', 1], [60, 'accept', 1],
    [5, 'submit', 2], [6, 'reserve', 2], [7, 'accept', 2],
  ]);
  const { rows } = reviewRows(history, { from: DAY + 35 * MIN, until: DAY + 24 * 60 * MIN });
  assert.deepEqual(rows.map(r => [r.item, r.attempt, r.outcome]), [[1, 2, 'accepted']]);
});
