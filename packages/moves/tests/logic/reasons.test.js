/** The reason lines next prints fold and count without a CLI: held queues, the review-cover pause and long lists [C7,#2895]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_COVER_PAUSE_TAIL } from '../../../health/index.js';
import {
  answerFirstReasons,
  foldedReasons,
  heldCounted,
} from '../../index.js';

const PAUSE = `review cover is short: ${REVIEW_COVER_PAUSE_TAIL}`;

test('moves.reasons.held-coordinator-lines-count-into-one: held-by-coordinator lines count into one line and every other reason stays in order [C7,#2895]', () => {
  const reasons = ['#1 is held by coordinator: fixture hold 1', '#2 waits on #9', '#3 is held by coordinator: fixture hold 3'];
  assert.deepEqual(heldCounted(reasons), ['2 items are held by coordinator', '#2 waits on #9']);
  assert.deepEqual(heldCounted(['#1 is held by coordinator: one']), ['1 item is held by coordinator']);
  assert.deepEqual(heldCounted(['#2 waits on #9']), ['#2 waits on #9']);
});

test('moves.reasons.review-cover-pause-line-leads-count: the review-cover pause line leads the count line and is never folded away [C7,#3741]', () => {
  const reasons = ['#1 is held by coordinator: fixture hold', '#2 waits on #9', PAUSE];
  assert.deepEqual(heldCounted(reasons), [PAUSE, '1 item is held by coordinator', '#2 waits on #9']);
  assert.deepEqual(answerFirstReasons(reasons), ['no item is free', PAUSE, '1 item is held by coordinator', '#2 waits on #9']);
});

test('moves.reasons.reasons-beyond-5-lines-fold-into: reasons beyond 5 lines fold into one counted line naming the full list [C7,#2895]', () => {
  const reasons = Array.from({ length: 8 }, (_, index) => `#${index + 1} waits on #99`);
  assert.deepEqual(foldedReasons(reasons, 'pullboard list core'), [...reasons.slice(0, 5), '+3 more reasons: pullboard list core']);
  assert.deepEqual(foldedReasons(reasons.slice(0, 5), 'pullboard list core'), reasons.slice(0, 5));
  assert.deepEqual(foldedReasons(reasons, 'pullboard list core', 2), [...reasons.slice(0, 2), '+6 more reasons: pullboard list core']);
});
