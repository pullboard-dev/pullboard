/** Active light seats keep their ready work while mid and strong seats use their own queue first [N2,B13]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';

/** Give each candidate a disjoint file so the queue's normal collision guard stays active. */
function brief(file) {
  return `Files: web/${file}.js\nTest: the selected route owns its ready work.`;
}

/** A successful native next claim carries autoNextSnapshot, unlike a manual claim. */
async function lightSeatRunsNext(box) {
  const task = box.add('Light seat activity', { route: 'light', brief: brief('light-seat-activity') });
  const result = await next(box);
  assert.equal(result.item?.item_id, task, JSON.stringify(result));
  const event = store.events(box.board).find(entry => entry.event_by === box.seats.actor.id
    && entry.event_kind === 'claim' && JSON.parse(entry.event_detail).autoNextSnapshot);
  assert.ok(event, 'the light seat recorded a claim made by next');
  return task;
}

test('moves.reserve-next-review-light.active-light-work-stays-behind-ready-mid: active light work stays behind ready mid and strong work even when light is prioritized [N2,B13]', async t => {
  const box = fixture(t, { boardFrom: cellBoard, route: 'light', reviewers: true });
  await lightSeatRunsNext(box);
  const strong = box.add('Strong work', { route: 'strong', brief: brief('strong-work') });
  const mid = box.add('Mid work', { route: 'mid', brief: brief('mid-work') });
  const light = box.add('Prioritized light work', { route: 'light', brief: brief('prioritized-light') });
  const midSeat = store.register(box.board, { lane: 'web', path: join(box.root, 'mid-seat'), route: 'mid' });

  const strongPick = store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] });
  assert.equal(strongPick.item.item_id, strong, 'ready strong work wins over a deliberately prioritized light item');
  assert.equal(strongPick.lightReserved.item_id, light);
  const midPick = store.nextFor(box.board, { agentId: midSeat, lane: 'web', priority: [light] });
  assert.equal(midPick.item.item_id, mid, 'ready mid work also wins over a deliberately prioritized light item');
  assert.equal(midPick.lightReserved.item_id, light);

  box.as('builder');
  const result = await next(box);
  assert.equal(result.item?.item_id, strong, JSON.stringify(result));
  assert.equal(result.lightReserved?.item_id, light, 'the prioritized light item is kept for active light seats');
});

test('moves.reserve-next-review-light.an-active-light-seat-does-not-block: an active light seat does not block fallback when no strong work is ready [N2,B13]', async t => {
  const box = fixture(t, { boardFrom: cellBoard, route: 'light', reviewers: true });
  await lightSeatRunsNext(box);
  const light = box.add('Only ready light work', { route: 'light', brief: brief('only-light') });

  box.as('builder');
  const result = await next(box);
  assert.equal(result.item?.item_id, light, JSON.stringify(result));
  assert.ok(!result.lightReserved, 'nothing is kept back for active light seats');
});

test('moves.reserve-next-review-light.light-work-is-available-freely-after-the: light work is available freely after the light seat has been quiet for 30 minutes [N2,B13]', async t => {
  const box = fixture(t, { boardFrom: cellBoard, route: 'light', reviewers: true });
  await lightSeatRunsNext(box);
  box.advance(31 * 60_000);
  const light = box.add('Light work after the quiet window', { route: 'light', brief: brief('quiet-light') });

  box.as('builder');
  const result = await next(box);
  assert.equal(result.item?.item_id, light, JSON.stringify(result));
  assert.ok(!result.lightReserved, 'nothing is kept back for active light seats');
});

test('moves.reserve-next-review-light.a-light-seat-review-reservation-also-counts: a light seat review reservation also counts as next activity [N2,B13]', t => {
  const box = fixture(t, { boardFrom: cellBoard, route: 'light', reviewers: true });
  const reviewerPath = join(box.root, 'light-review-seat');
  const reviewer = store.register(box.board, { lane: 'review', path: reviewerPath, route: 'light', family: 'Family Beta' });
  const submitted = box.add('Submission for the light reviewer', { route: 'light', brief: brief('reviewed-light') });
  box.submit(submitted);
  const reservation = store.reserveNextReview(box.board, { agentId: reviewer, lane: 'review', leaseMs: 60_000, policy: 'any' });
  assert.equal(reservation.item.item_id, submitted);

  const strong = box.add('Strong work', { route: 'strong', brief: brief('review-next-strong') });
  const light = box.add('Prioritized light work', { route: 'light', brief: brief('review-next-light') });
  const picked = store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] });
  assert.equal(picked.item.item_id, strong, 'the canonical reserve event counts for a light seat that ran next --verify');
});
