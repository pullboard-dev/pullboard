/** Automatic claims that do not touch a clean seat do not trigger the failed-release hold [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossLaneFixture } from './e2e-helpers.js';

test('real next and release preserve an untouched item for another builder [C7,H16]', t => {
  const box = crossLaneFixture(t);
  const seat = box.seat('core-seat', 'core', box.session);
  const id = box.add('core', 'Untouched automatic claim');
  for (let index = 0; index < 2; index++) {
    const next = box.json(box.runAs(box.session, seat.root, 'next', '--build', '--json'));
    assert.equal(next.item.item_id, id);
    box.json(box.runAs(box.session, seat.root, 'release', String(id), '--reason', 'ROUTED_ELSEWHERE', '--note', 'Routed elsewhere without work.', '--no-next', '--json'));
  }
  const next = box.json(box.runAs(box.session, seat.root, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, id, 'two untouched releases did not hold the item');
});
