/** Automatic claims that do not touch a clean seat do not trigger the failed-release hold [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossLaneFixture } from '../../../tests/fixtures/e2e.js';

test('real next and release preserve an untouched item for another builder [C7,H16]', t => {
  const box = crossLaneFixture(t);
  const seat = box.seat('core-seat', 'web', box.session);
  const id = box.add('web', 'Untouched automatic claim');
  for (let index = 0; index < 2; index++) {
    const next = box.json(box.runAs(box.session, seat.root, 'next', '--build', '--json'));
    assert.equal(next.item.item_id, id);
    box.json(box.runAs(box.session, seat.root, 'release', String(id), '--reason', 'ROUTED_ELSEWHERE', '--note', 'Routed elsewhere without work.', '--no-next', '--json'));
  }
  const next = box.json(box.runAs(box.session, seat.root, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, id, 'two untouched releases did not hold the item');
});


test('matching pre-existing edits are untouched, but later content changes count [C7,H16]', t => {
  const box = crossLaneFixture(t);
  const seat = box.seat('dirty-seat', 'web', box.session);
  const id = box.add('web', 'Existing worktree edits');
  const file = join(seat.root, 'already-dirty.txt');
  writeFileSync(file, 'before');
  const take = () => box.json(box.runAs(box.session, seat.root, 'next', '--take', '--json'));
  const release = () => box.json(box.runAs(box.session, seat.root, 'release', String(id), '--reason', 'BUDGET', '--note', 'Budget spent.', '--no-next', '--json'));
  assert.equal(take().item.item_id, id); release();
  assert.equal(take().item.item_id, id); release();
  assert.equal(take().item.item_id, id);
  writeFileSync(file, 'after'); release();
  assert.equal(take().item.item_id, id);
  writeFileSync(file, 'again'); release();
  const held = box.runAs(box.session, seat.root, 'next', '--take', '--json');
  assert.notEqual(held.code, 0, 'two changed releases hold the item');
});
