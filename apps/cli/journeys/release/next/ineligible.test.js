/** INELIGIBLE releases remove an item from that seat's automatic next offers, without blocking other seats [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../../tests/fixtures/next/take.js';

test('clause 1: INELIGIBLE release is never offered back to that seat, while another seat still gets it [N2]', async t => {
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
