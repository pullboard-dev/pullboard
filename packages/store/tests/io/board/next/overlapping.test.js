/** next offers open work that only overlaps other claims, since claim accepts it [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';

/** A real repo and board with an actor seat at the repo root and a peer builder in the same lane. */
function fixture(t) {
  const project = cellProject(t);
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const board = cellBoard(t, project.boardFile, { now: () => new Date(at) }, { gitRoot: project.repo });
  const builderPath = join(project.dir, 'builder');
  mkdirSync(builderPath);
  const seats = { actor: cellSeat(board, { lane: 'web', path: project.repo }), builder: cellSeat(board, { lane: 'web', path: builderPath }) };
  for (const seat of Object.values(seats)) store.heartbeatSeat(board, seat.id);
  return {
    board, seats,
    /** File an ordinary runnable item in the actor's lane; every item names the same file, so each overlaps the others. */
    add: title => cellItem(board, { lane: 'web', title, criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'], route: 'strong',
      brief: 'Files: web/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.' }).item_id,
    /** Claim an item for a seat, as a peer racing the actor would. */
    claim: (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } }),
  };
}

test('clause 1: next --take offers an item whose files overlap another claim, with an overlap note [C7]', t => {
  const box = fixture(t);
  const held = box.add('Held by the builder');
  box.claim(held);
  const open = box.add('Overlaps the builder claim');
  const pick = store.nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web' });
  assert.equal(pick.item?.item_id, open, JSON.stringify(pick.reasons));
  assert.match(pick.reasons.join('\n'), /overlap/);
});

test('clause 2: next never returns nothing-eligible while an unheld item claim would accept exists [C7]', t => {
  const box = fixture(t);
  box.claim(box.add('First held'));
  const open = box.add('Still claimable');
  const pick = store.nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web' });
  assert.equal(pick.item?.item_id, open);
  assert.doesNotThrow(() => box.claim(open, box.seats.actor), 'claim accepts the offered item');
  assert.notEqual(pick.idleReason, 'nothing-eligible');
});
