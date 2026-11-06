/** next offers open work that only overlaps other claims, since claim accepts it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixture } from './next-take-fixture.js';

test('next --take offers an item whose files overlap another claim, with an overlap note [C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held by the builder');
  box.claim(held);
  const open = box.add('Overlaps the builder claim');
  const pick = store.nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web' });
  assert.equal(pick.item?.item_id, open, JSON.stringify(pick.reasons));
  assert.match(pick.reasons.join('\n'), /overlap/);
});

test('next never returns nothing-eligible while an unheld item claim would accept exists [C7]', async t => {
  const box = await fixture(t);
  box.claim(box.add('First held'));
  const open = box.add('Still claimable');
  const pick = store.nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web' });
  assert.equal(pick.item?.item_id, open);
  assert.doesNotThrow(() => box.claim(open, box.seats.actor), 'claim accepts the offered item');
  assert.notEqual(pick.idleReason, 'nothing-eligible');
});
