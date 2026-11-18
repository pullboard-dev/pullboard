/** next leaves an item a seat just released to other seats for the configured cooldown [B3,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { configFromSource } from '../../../../../config/index.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { take } from '../../../fixtures/next.js';

/** Claim an item for the actor seat and release it, as a seat that gives work back does. */
function claimAndRelease(box, id) {
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'Give the fixture item back to the board', 'OTHER');
}

test('moves.record-next-idle-cooldown.a-seat-that-released-item-a-is: a seat that released item A is offered item B, and A once the cooldown passes [B3,N2]', async t => {
  const box = fixture(t);
  const a = box.add('Item A');
  const b = box.add('Item B');
  claimAndRelease(box, a);
  const offered = await take(box);
  assert.equal(offered.item.item_id, b, 'the released item is not offered back while other work is open');
  store.release(box.board, b, box.seats.actor.id, 'Give the fixture item back to the board', 'OTHER');
  box.advance(31 * 60_000);
  claimAndRelease(box, b);
  const later = await take(box);
  assert.equal(later.item.item_id, a, 'after 30 minutes the released item is offered again');
});

test('moves.record-next-idle-cooldown.plain-next-the-command-seats-loop-on: plain next, the command seats loop on, also offers item B after item A was released [B3,N2]', async t => {
  const box = fixture(t);
  const a = box.add('Item A');
  const b = box.add('Item B');
  claimAndRelease(box, a);
  await next(box, { build: true });
  assert.equal(store.getItem(box.board, b).item_owner, box.seats.actor.id);
  assert.equal(store.getItem(box.board, a).item_status, 'open');
});

test('moves.record-next-idle-cooldown.with-only-the-released-item-open-the: with only the released item open, the seat is offered it [B3,N2]', async t => {
  const box = fixture(t);
  const a = box.add('Item A');
  claimAndRelease(box, a);
  const offered = await take(box);
  assert.equal(offered.item.item_id, a);
});

test('moves.record-next-idle-cooldown.claims-release-cooldown-minutes-defaults-to-30-and-refuses-a: claims.releaseCooldownMinutes defaults to 30 and refuses a negative or non-number value [B3]', () => {
  assert.equal(configFromSource('{}').claims.releaseCooldownMinutes, 30);
  assert.equal(configFromSource('{"claims":{"releaseCooldownMinutes":0}}').claims.releaseCooldownMinutes, 0);
  for (const value of [-1, '30', null]) {
    assert.throws(() => configFromSource(JSON.stringify({ claims: { releaseCooldownMinutes: value } })), { code: 'BAD_CONFIG' });
  }
});
