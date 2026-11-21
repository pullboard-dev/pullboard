/** A builder seat is reserved no review while a review-lane seat is alive, at REVIEWER_ALIVE_RESERVE_ENGINE [C7,V15,#12556]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { REVIEWER_ALIVE_RESERVE_ENGINE } from '../../../../../state/light.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';

/** A submitted item and a second build seat, in the web lane, from another family so only the reviewer rule decides. */
function setup(t) {
  const box = fixture(t, { boardFrom: cellBoard, reviewers: true });
  const id = box.add('Submission waiting for a review');
  box.submit(id);
  const path = join(box.project.dir, 'second-builder');
  mkdirSync(path);
  const seat = cellSeat(box.board, { lane: 'web', path, family: 'Family Beta' }).id;
  box.as({ id: seat, lane: 'web' });
  return { box, id, seat };
}

test('moves.reserve-next-review-reviewer-alive.builder-gets-no-review-while-reviewer-alive: clause 1: at REVIEWER_ALIVE_RESERVE_ENGINE a builder seat is reserved no review while a review-lane seat is alive [C7,V15]', async t => {
  const { box, id, seat } = setup(t);
  box.board.executionEngineVersion = REVIEWER_ALIVE_RESERVE_ENGINE;
  store.heartbeatSeat(box.board, seat);
  const found = await next(box, { verify: true });
  assert.equal(found.item ?? null, null, JSON.stringify(found));
  assert.equal(store.getItem(box.board, id).item_review_by ?? null, null, 'nothing is reserved for the builder seat');
});

test('moves.reserve-next-review-reviewer-alive.builder-reserved-with-no-reviewer-alive: clause 2: with no review-lane seat alive a builder seat is reserved a review as on main [C7,V15]', async t => {
  const { box, id, seat } = setup(t);
  box.board.executionEngineVersion = REVIEWER_ALIVE_RESERVE_ENGINE;
  box.advance(3 * 60_000);
  store.heartbeatSeat(box.board, seat);
  const found = await next(box, { verify: true });
  assert.equal(found.item?.item_id, id, JSON.stringify(found));
  assert.equal(store.getItem(box.board, id).item_review_by, seat);
});

test('moves.reserve-next-review-reviewer-alive.history-before-engine-replays-unchanged: clause 3: a history recorded before REVIEWER_ALIVE_RESERVE_ENGINE replays unchanged [C7,V15]', async t => {
  const { box, id, seat } = setup(t);
  box.board.executionEngineVersion = REVIEWER_ALIVE_RESERVE_ENGINE - 1;
  store.heartbeatSeat(box.board, seat);
  const found = await next(box, { verify: true });
  assert.equal(found.item?.item_id, id, JSON.stringify(found));
  assert.equal(store.getItem(box.board, id).item_review_by, seat);
});
