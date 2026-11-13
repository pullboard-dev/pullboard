/** The window comparison's Sent back share and Rework time count only what reviewers sent back [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareFlowWindows } from '../../../../packages/stats/index.js';
import { BASE } from '../../../../packages/store/tests/fixtures/stats/compare.js';
import { at } from '../../../../packages/store/tests/fixtures/stats/compare.js';
import { fixture } from '../../../../packages/store/tests/fixtures/stats/compare.js';

test('Sent back is the share of finished reviews and Rework starts at a send-back, not at a release [R1,R2]', t => {
  const a = 'a'.repeat(40);
  const lease = { leaseUntil: at(200) };
  const box = fixture(t, [
    ...[1, 2, 3, 4].flatMap(id => [[0, 'coordinator', 'add', id, { lane: 'core' }], [0, 'core-1', 'claim', id, lease]]),
    [10, 'core-1', 'submit', 2, { commit: a }], [20, 'core-1', 'submit', 3, { commit: a }],
    // Item 4 is handed back by its builder and nobody sends it back: it waits 35 minutes as ready work.
    [65, 'core-1', 'release', 4, {}], [100, 'core-1', 'claim', 4, lease],
    [70, 'core-1', 'submit', 1, { commit: a }],
    [75, 'review-1', 'reserve', 1, { until: at(200) }], [80, 'review-1', 'reject', 1, { commit: a }],
    [83, 'review-1', 'reserve', 2, { until: at(200) }], [85, 'review-1', 'reject', 2, { commit: a }],
    [86, 'review-1', 'reserve', 3, { until: at(200) }], [90, 'review-1', 'accept', 3, { commit: a }],
    [95, 'coordinator', 'merged', 3],
  ]);
  const { current } = compareFlowWindows(box.history(), { now: BASE + 120 * 60_000, windowMinutes: 60, complete: true });
  assert.equal(current.submissions, 1, 'two of the reviewed items were submitted before the window');
  assert.equal(current.rejectRate, 2 / 3, 'two sent back of three finished reviews, never more than all of them');
  assert.equal(current.stageHours.rework, 75 / 60, 'items 1 and 2 are reworked from their send-backs (40 and 35 minutes); item 4 is not');
});
