/** INELIGIBLE history leaves manual claims available, excludes the item from automatic review, and ordinary release falls back [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { take } from '../../../fixtures/next.js';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';

/** Make a realistic user release through the board's release move. */
function release(box, id, reason) {
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot take this work.', undefined, reason);
}

test('moves.release-offers.ineligible-history-leaves-explicit-manual-claim-available: clause 2: INELIGIBLE history leaves explicit manual claim available [N2]', t => {
  const box = fixture(t, { boardFrom: cellBoard });
  const id = box.add('Manually claimable item');
  release(box, id, 'INELIGIBLE');

  cellClaim(box.board, id, box.seats.actor, { root: box.root });
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
});

test('moves.release-offers.ineligible-history-excludes-an-item-from-automatic: INELIGIBLE history excludes an item from automatic review after another author submits it [N2,V1]', async t => {
  const box = fixture(t, { boardFrom: cellBoard });
  const id = box.add('Review after ineligible build release');
  const eligiblePeer = box.add('Other eligible review');
  release(box, id, 'INELIGIBLE');
  box.submit(id);
  assert.equal(store.getItem(box.board, id).item_built_by, box.seats.builder.id, 'the fixture submission belongs to another seat');
  box.submit(eligiblePeer);
  box.advance(16 * 60_000);

  const offered = await next(box, { verify: true });
  assert.equal(offered.item.item_id, eligiblePeer, 'an eligible peer review remains selectable');
  assert.equal(offered.review, true);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'the excluded item was not reserved for review');
  assert.equal(store.getItem(box.board, eligiblePeer).item_review_by, box.seats.actor.id, 'the positive control was reserved');
});

test('moves.release-offers.ordinary-release-still-falls-back-to-its: ordinary release still falls back to its only open item [B3,N2]', async t => {
  const box = fixture(t, { boardFrom: cellBoard });
  const id = box.add('Ordinarily released item');
  release(box, id, 'OTHER');
  const offered = await take(box);
  assert.equal(offered.item.item_id, id);
});
