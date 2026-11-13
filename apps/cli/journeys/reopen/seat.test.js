/** A reopen first-refusal hold waits only for a builder whose seat can still come back [B4,B5,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import {
  claim as storeClaim,
  itemById,
  firstRefusal,
} from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';

const MINUTE = 60_000;

/** Claim with a frozen bar for the given seat and lease. */
function claim(box, id, agentId, leaseMs) {
  return storeClaim(box.board, id, { agentId, lane: 'web', leaseMs, freeze: item => ({ text: item.item_title, digest: 'reopen-hold-gone-seat' }) });
}

/**
 * Let the builder's 30-minute lease lapse an hour ago with its last heartbeat 92 minutes old, then let a native write
 * return the claim with the builder's 30-minute first-refusal window.
 */
async function returnedForBuilder(t) {
  const box = await fixture(t);
  const id = box.add('Private claim whose seat stopped');
  heartbeatSeat(box.board, box.seats.builder.id);
  claim(box, id, box.seats.builder.id, 30 * MINUTE);
  box.advance(92 * MINUTE);
  const write = await cli(box, box.seats.actor.path, ['shout', 'all', '--kind', 'idea', 'Private write returns the lapsed claim.']);
  assert.equal(write.code, 0, write.out + write.err);
  assert.equal(itemById(box.board, id).item_status, 'open');
  const window = firstRefusal(box.board, id);
  assert.equal(window?.builder, box.seats.builder.id, 'the return reserves the first refusal for the builder');
  assert.ok(Date.parse(window.until) > box.clock.now().getTime(), 'the window is still open');
  return { box, id };
}

test('clause 1: a first-refusal hold for a gone seat is lifted [B4,B5,C7]', async t => {
  const { box, id } = await returnedForBuilder(t);
  claim(box, id, box.seats.actor.id, 120 * MINUTE);
  assert.equal(itemById(box.board, id).item_owner, box.seats.actor.id, 'a builder silent for over two minutes no longer holds another seat off');
});

test('a first-refusal hold for a live seat still refuses another seat [B4,B5,C7]', async t => {
  const { box, id } = await returnedForBuilder(t);
  heartbeatSeat(box.board, box.seats.builder.id);
  assert.throws(() => claim(box, id, box.seats.actor.id, 120 * MINUTE), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  assert.equal(itemById(box.board, id).item_status, 'open');
});
