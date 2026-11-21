/** The reason lines next prints fold and count without a CLI: held queues, the review-cover pause and long lists [C7,#2895]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { REVIEW_COVER_PAUSE_TAIL } from '../../../health/index.js';
import { recordSubmitHandoff } from '../../../jobs/index.js';
import * as store from '../../../store/index.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import {
  answerFirstReasons,
  foldedReasons,
  heldCounted,
  ownWaitingLines,
} from '../../index.js';
import { fixture } from '../fixtures/next.js';

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

test('moves.reasons.own-waiting-lines-in-flight-read: clause 1: ownWaitingLines names a submitted item and a claim in its gate as the whole open list gives, and sends the board no open-items list query [C7,#5329]', t => {
  const box = fixture(t, { boardFrom: cellBoard });
  const me = box.seats.actor;
  const reviewed = box.add('Submitted and waiting for a reviewer');
  const gated = box.add('Claimed and waiting on its gate');
  box.add('Still open');
  box.claim(reviewed, me);
  submitFixture(box.board, reviewed, { agentId: me.id, commit: '1'.repeat(40), tree: '1'.repeat(40) });
  box.claim(gated, me);
  recordSubmitHandoff(box.board.db, gated, { version: 1, id: `job-${gated}`, agentId: me.id, commit: 'c'.repeat(40),
    digest: store.getItem(box.board, gated).item_frozen_digest, state: 'queued' });
  // A second connection has remembered no list, so a read it makes reaches the board's tables.
  const reader = cellBoard(t, box.project.boardFile, undefined, { real: true });
  const prepared = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function recording(sql) { prepared.push(String(sql)); return prepare.call(this, sql); };
  let lines;
  try { lines = ownWaitingLines(reader, me); } finally { DatabaseSync.prototype.prepare = prepare; }
  const expected = store.listItems(reader).filter(item => item.item_owner === me.id && (item.item_status === 'submitted' || store.awaitingGateOrReview(reader, item)))
    .map(item => `#${item.item_id} is waiting on its ${item.item_status === 'submitted' ? 'reviewer' : 'gate'}; next offers other work`);
  assert.deepEqual([...lines].sort(), [`#${gated} is waiting on its gate; next offers other work`, `#${reviewed} is waiting on its reviewer; next offers other work`].sort());
  assert.deepEqual(lines, expected, 'the same lines, in the same order, as the whole open list gives');
  assert.deepEqual(prepared.filter(sql => /item_status NOT IN \('verified','withdrawn'\)/u.test(sql)), [], 'no statement lists the open items');
});
