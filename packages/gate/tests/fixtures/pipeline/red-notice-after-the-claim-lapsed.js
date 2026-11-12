/**
 * Invariant: the red-gate notice reads the live lease and says the claim lapsed, never that the item "stays claimed by
 * you until" a time already past [C7,SM13].
 * Repro: a seat whose red queued gate sat unread past its lease was told "#N stays claimed by you until <past time>"
 * though maintenance could free the claim at any moment. The notice now compares the lease with the board's clock.
 * Runs on a real Git repository and a real SQLite board; the red record is the gate job's own step.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { from } from './kit.js';

// The notice is the store's own; it is not on the store front door, so the harness loads it by path like the other pipeline harnesses.
const { sayQueuedReds } = await from('packages/store/src/io/queued/red.js');
const START = Date.parse('2026-11-12T10:00:00.000Z');
const LEASE_MS = 60_000;

/** A claimed item whose queued gate went red, on a board whose clock the test moves. */
function redClaim(t) {
  const repo = cellRepo(t);
  const clock = { at: START, now() { return new Date(this.at); } };
  const board = cellBoard(t, repo.boardFile, clock, { gitRoot: repo.root });
  const seat = cellSeat(board, { lane: 'web', path: repo.root });
  const item = cellItem(board, { lane: 'web', title: 'Red page', criterion: 'The page renders.', specIds: ['G1'], check: 'true' });
  cellClaim(board, item.item_id, seat, { root: repo.root, leaseMs: LEASE_MS });
  const claimed = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(item.item_id);
  createJob(board.db, { id: `gate:${item.item_id}`, kind: 'gate', item: item.item_id, candidate: repo.commit, now: START });
  const record = { state: 'red', agentId: seat.id, digest: claimed.item_frozen_digest, commit: repo.commit,
    error: { code: 'GATE_RED', message: 'the page did not render', next: 'fix it' } };
  writeStep(board.db, `gate:${item.item_id}`, 'done', { record }, { now: START });
  return { board, clock, seat, id: item.item_id, lease: claimed.item_lease_until };
}

/** What the seat is told, as the lines `next` and `claim` print. */
function told(fixture, bounded) {
  const lines = [];
  sayQueuedReds({ say: line => lines.push(line) }, fixture.board, () => ({ id: fixture.seat.id }), { bounded });
  return lines.join('\n');
}

test('a red notice for a live claim says it stays claimed until the lease [C7,SM13]', t => {
  const fixture = redClaim(t);
  for (const bounded of [false, true]) {
    const text = told(fixture, bounded);
    assert.match(text, new RegExp(`#${fixture.id} stays claimed by you until ${fixture.lease}`, 'u'));
    assert.doesNotMatch(text, /lapsed/u);
  }
});

test('a red notice read after the lease ran out says the claim lapsed, never that it stays claimed [C7,SM13]', t => {
  const fixture = redClaim(t);
  fixture.clock.at = START + 10 * LEASE_MS;
  for (const bounded of [false, true]) {
    const text = told(fixture, bounded);
    assert.match(text, new RegExp(`#${fixture.id} claim lapsed at ${fixture.lease}`, 'u'), 'it says the claim lapsed');
    assert.match(text, /re-claim/u, 'it names the way back');
    assert.doesNotMatch(text, /stays claimed/u, 'it never promises a claim that is gone');
  }
});
