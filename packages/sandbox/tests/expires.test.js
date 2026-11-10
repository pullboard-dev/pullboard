/** A re-scope exclusion from a release expires when its reason is gone, so next --take offers the item again [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { heartbeatSeat } from '../../store/index.js';
import { fixture } from './fixtures/ports.js';
import { take } from './fixtures/ports.js';

/** Claim an item for the actor seat and release it for re-scope. */
function giveBack(box, title, reason, options) {
  const id = box.add(title);
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'The fixture seat cannot build this item as scoped', options, reason);
  return id;
}

/** What the sibling builder seat is offered by next --take. */
async function offeredTo(box) {
  box.as('builder');
  const next = await take(box);
  return next.item?.item_id ?? null;
}

test('clause 1: a ROUTED_ELSEWHERE release stays excluded while its seat is live and is offered again once the session is gone [C7]', async t => {
  const box = fixture(t);
  const id = giveBack(box, 'Routed to a live seat', 'ROUTED_ELSEWHERE');
  box.advance(31 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'the seat last beat 31 minutes ago: its session still holds the item');
  box.advance(20 * 60_000);
  assert.equal(await offeredTo(box), id, 'the session has been silent past the window');
});

test('clause 1: a ROUTED_ELSEWHERE release is offered again once the releasing seat folder is gone [C7]', async t => {
  const box = fixture(t);
  const id = giveBack(box, 'Routed to a seat whose folder goes', 'ROUTED_ELSEWHERE');
  box.advance(31 * 60_000);
  heartbeatSeat(box.board, box.seats.actor.id);
  assert.notEqual(await offeredTo(box), id, 'live seat with its folder: excluded');
  rmSync(store.agentById(box.board, box.seats.actor.id).agent_path, { recursive: true, force: true });
  assert.equal(await offeredTo(box), id, 'the folder is gone');
});

test('clause 1: a BLOCKED release with no blocker list is offered again after the cooldown [C7]', async t => {
  const box = fixture(t);
  const id = giveBack(box, 'Blocked with no list', 'BLOCKED');
  box.advance(31 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'inside the cooldown');
  box.advance(31 * 60_000);
  assert.equal(await offeredTo(box), id, 'after the bounded cooldown');
});

test('clause 1: a BLOCKED release naming an unlanded blocker stays excluded until the blocker lands [C7]', async t => {
  const box = fixture(t);
  const blocker = box.add('Unlanded blocker');
  const id = giveBack(box, 'Blocked on a named item', 'BLOCKED', { blockedOn: [blocker] });
  box.advance(24 * 60 * 60_000);
  assert.notEqual(await offeredTo(box), id, 'a day later the blocker is still unlanded');
});
