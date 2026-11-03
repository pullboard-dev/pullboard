/** INELIGIBLE releases remove an item from that seat's automatic next offers, without blocking other seats or manual claims. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

/** Make a realistic user release through the board's release move. */
function release(box, id, reason) {
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot take this work.', reason);
}

test('INELIGIBLE release is never offered back to that seat, while another seat still gets it [N2]', async t => {
  const box = await fixture(t);
  const id = box.add('Ineligible item');
  const autoClaim = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(autoClaim.code, 0, autoClaim.out + autoClaim.err);
  assert.equal(autoClaim.document.item.item_id, id);
  const gaveBack = await cli(box, box.seats.actor.path,
    ['release', String(id), '--reason', 'INELIGIBLE', '--note', 'This seat cannot take the work.', '--no-next']);
  assert.equal(gaveBack.code, 0, gaveBack.out + gaveBack.err);
  const releaseDetail = JSON.parse(store.events(box.board, { itemId: id }).findLast(event => event.event_kind === 'release').event_detail);
  assert.equal(releaseDetail.untouchedAutoClaim, true, 'the fixture exercises a real untouched automatic claim release');
  box.advance(31 * 60_000);

  const sameSeat = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.notEqual(sameSeat.code, 0, 'the ineligible sole item has no automatic-offer fallback');
  assert.equal(store.getItem(box.board, id).item_status, 'open');

  const otherSeat = await cli(box, box.seats.builder.path, ['next', '--take']);
  assert.equal(otherSeat.code, 0, otherSeat.out + otherSeat.err);
  assert.equal(otherSeat.document.item.item_id, id);
});

test('INELIGIBLE history leaves explicit manual claim available [N2]', async t => {
  const box = await fixture(t);
  const id = box.add('Manually claimable item');
  release(box, id, 'INELIGIBLE');

  const claimed = await cli(box, box.seats.actor.path, ['claim', String(id), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
});

test('INELIGIBLE history excludes an item from automatic review after another author submits it [N2,V1]', async t => {
  const box = await fixture(t);
  const id = box.add('Review after ineligible build release');
  const eligiblePeer = box.add('Other eligible review');
  release(box, id, 'INELIGIBLE');
  box.submit(id);
  assert.equal(store.getItem(box.board, id).item_built_by, box.seats.builder.id, 'the fixture submission belongs to another seat');
  box.submit(eligiblePeer);
  box.advance(16 * 60_000);

  const offered = await cli(box, box.seats.actor.path, ['next', '--verify']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, eligiblePeer, 'an eligible peer review remains selectable');
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, id).item_review_by, null, 'the excluded item was not reserved for review');
  assert.equal(store.getItem(box.board, eligiblePeer).item_review_by, box.seats.actor.id, 'the positive control was reserved');
});

test('ordinary release still falls back to its only open item [B3,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('Ordinarily released item');
  release(box, id, 'OTHER');
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, id);
});
