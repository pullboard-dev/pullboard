/** Cross-lane next: laneMode off offers a light seat light work from any lane [C7,#8940]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSelection } from '../../../../packages/moves/index.js';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Run next as the light actor seat and return what the selection decided, before any claim guard runs. */
async function picked(t, box) {
  const original = nextSelection.pick;
  const decisions = [];
  nextSelection.pick = (...args) => { const found = original(...args); decisions.push(found); return found; };
  try { await cli(box, box.seats.actor.path, ['next', '--build']); } finally { nextSelection.pick = original; }
  return decisions[0];
}

test('clause 1: with laneMode off, next offers a light seat an open light item from another lane [C7]', async t => {
  const box = await fixture(t, { route: 'light', projectConfig: { laneMode: 'off' } });
  const docs = box.add('Light docs-lane work', { lane: 'docs', route: 'light' });
  const decision = await picked(t, box);
  assert.equal(decision.claim, true, JSON.stringify(decision));
  assert.equal(decision.item.item_id, docs);
  assert.equal(decision.item.item_lane, 'docs', 'the offered item is not in the seat\'s own web lane');
  assert.equal(decision.move, undefined, 'the seat is offered the item where it stands, not moved');
  assert.equal(store.getItem(box.board, docs).item_lane, 'docs');
});

test('clause 2: with laneMode on, the same seat is offered only its own lane items [C7]', async t => {
  const box = await fixture(t, { route: 'light', projectConfig: { laneMode: 'on' } });
  const docs = box.add('Light docs-lane work', { lane: 'docs', route: 'light' });
  const decision = await picked(t, box);
  assert.notEqual(decision.claim, true, JSON.stringify(decision));
  assert.notEqual(decision.item?.item_id, docs, 'another lane\'s item is never offered for a claim');
  assert.equal(store.getItem(box.board, docs).item_status, 'open');
  const own = box.add('Light web-lane work', { route: 'light' });
  const again = await picked(t, box);
  assert.equal(again.claim, true, JSON.stringify(again));
  assert.equal(again.item.item_id, own, 'its own lane item is the offer');
});
