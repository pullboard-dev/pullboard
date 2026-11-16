/** Next offers an open slice to a free seat in the slice's lane only [C7,#8810]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** A claimed parent held by the builder, one open slice of it in the given lane; the fixture's free seats sit in the web and review lanes. */
async function sliced(t, lane) {
  const box = await fixture(t);
  const parent = box.add('Parent with a slice');
  box.claim(parent);
  const slice = store.createItemSlice(box.board, { agentId: box.seats.builder.id, parentId: parent,
    parentDigest: store.getItem(box.board, parent).item_frozen_digest, title: 'Part of the parent', lane,
    files: [`${lane}/part.js`], check: 'true' }).item;
  return { box, slice };
}

test('clause 1: next offers an open slice to a free seat in the slice lane [C7,#8810]', async t => {
  const { box, slice } = await sliced(t, 'review');
  assert.equal(store.nextFor(box.board, { agentId: box.seats.sibling.id, lane: 'review' }).item?.item_id, slice);
});

test('clause 2: a seat in another lane is never offered the slice [C7,#8810]', async t => {
  const { box, slice } = await sliced(t, 'review');
  assert.notEqual(store.nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web' }).item?.item_id, slice);
});

test('clause 1: a free seat is offered a whole item of the focused release before an open slice [C7,#8811]', async t => {
  const { box, slice } = await sliced(t, 'review');
  const whole = box.add('Whole item of the focused release');
  store.addMilestone(box.board, { agentId: 'coordinator', reason: 'Focus the release for the fixture', name: 'focused', items: [whole] });
  assert.equal(store.nextFor(box.board, { agentId: box.seats.sibling.id, lane: 'review' }).item?.item_id, whole);
  assert.notEqual(store.nextFor(box.board, { agentId: box.seats.sibling.id, lane: 'review' }).item?.item_id, slice);
});
