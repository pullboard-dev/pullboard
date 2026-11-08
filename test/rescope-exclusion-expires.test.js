/** A re-scope exclusion from a release expires, so next offers the item again [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

for (const reason of ['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']) {
  test(`a ${reason} release hides the item from a sibling seat only for the exclusion window, then next offers it again [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item released for re-scope');
    box.claim(id, box.seats.actor);
    store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', reason);
    box.advance(31 * 60_000);
    const hidden = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.notEqual(hidden.document?.item?.item_id, id, 'inside the window the sibling is not offered it');
    assert.equal(store.allItemsNeedingRescope(box.board).length, 1, 'status and health still list it');
    box.advance(31 * 60_000);
    const offered = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(offered.code, 0, offered.out + offered.err);
    assert.equal(offered.document.item.item_id, id, 'after the window the exclusion has expired');
  });
}
