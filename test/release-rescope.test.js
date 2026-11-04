/** A BLOCKED, ROUTED_ELSEWHERE or INELIGIBLE release stops next offering the item to that lane and route and shows it as needing re-scope [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

/** Claim an item for a seat and release it with a reason, as a seat that gives work back does. */
function giveBack(box, id, seat, reason) {
  box.claim(id, seat);
  store.release(box.board, id, seat.id, 'The fixture seat cannot build this item as scoped', reason);
}

for (const reason of ['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']) {
  test(`${reason} stops next offering the item to the same lane and route, and status names it [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item that needs re-scope');
    giveBack(box, id, box.seats.actor, reason);
    box.advance(31 * 60_000);
    const sibling = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.notEqual(sibling.document?.item?.item_id, id, `a second seat of the same lane and route is not offered the ${reason} item`);
    assert.equal(store.getItem(box.board, id).item_status, 'open');
    const rescope = store.allItemsNeedingRescope(box.board);
    assert.equal(rescope.length, 1);
    assert.equal(rescope[0].id, id);
    assert.match(rescope[0].reasons[0], new RegExp(reason));
    const status = await cli(box, box.root, ['status']);
    assert.equal(status.document.needsRescope[0].id, id, 'status shows the item as needing re-scope with its release reasons');
    store.editItem(box.board, id, { agentId: 'coordinator', criterion: 'The fixture succeeds after the coordinator re-scoped the item.', reason: 'The first bar named work this lane could not build.' });
    assert.deepEqual(store.allItemsNeedingRescope(box.board), [], 'an edit returns the item to the lane and route');
    const again = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(again.document.item.item_id, id, 'after the edit next offers the item again');
  });
}

for (const reason of ['OTHER', 'BUDGET', 'TAKEN_OVER']) {
  test(`${reason} keeps today's behaviour and never marks the item for re-scope [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item given back for another reason');
    box.claim(id, box.seats.actor);
    store.release(box.board, id, box.seats.actor.id, 'Give the fixture item back to the board', reason);
    assert.deepEqual(store.allItemsNeedingRescope(box.board), []);
    box.advance(31 * 60_000);
    const sibling = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(sibling.document.item.item_id, id, `${reason} leaves the item offered to the same lane and route`);
  });
}
