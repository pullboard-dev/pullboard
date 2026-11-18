/** The claim shadow compare reads the writer's own clock instant, so a ticking board clock does not read as a disagreement [C7]. */
/** @pullboard-test-input packages/store/src/io/board/claim.js packages/store/src/io/board/claim-table.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');

/** A shadowed board whose clock moves 5 ms on every read, with one open item and a seat to claim it. */
function ticking(t) {
  let reads = 0;
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT + 5 * reads++) });
  board.movesShadow = true;
  // The shadow compare runs only while the writer decides; with moves.live.claim on (its default since #8395) the table decides and compares nothing.
  board.movesLive = { claim: false };
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const seat = cellSeat(board, { lane: 'core', path: '/seat/builder' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Ticking claim', criterion: '1. the claim is recorded [test].', route: 'strong', check: 'true' });
  const claim = () => store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 60 * 60_000, freeze: () => ({ text: 'frozen', digest: 'clock-digest' }) });
  return { board, id, claim };
}

test('board.claim-shadow-clock.claim-and-renewal-ticking-board-clock: clause 1: a claim and a renewal on a ticking board clock each record a compare with no disagreement [C7]', t => {
  const { board, claim } = ticking(t);
  claim();
  claim();
  const counts = store.readShadow(board, 'claim');
  assert.equal(counts.compared, 2, 'the claim and the renewal were each compared');
  assert.equal(counts.disagreed, 0, `the clock read once per claim: ${JSON.stringify(counts.last)}`);
});

test('board.claim-shadow-clock.table-answer-with-different-owner-still: clause 2: a table answer with a different owner still records a differing path [C7]', t => {
  const { board, id } = ticking(t);
  const hook = store.shadowHook(board, 'claimShadow', 'claim', store.claimDiffers, () => false);
  const wrote = { kind: 'claim', by: 'core-1', detail: JSON.stringify({ leaseUntil: 1, digest: 'd' }) };
  hook({ id, decided: { events: [{ kind: 'claim', by: 'core-2', detail: { leaseUntil: 1, digest: 'd' } }] }, wrote: [wrote] });
  const counts = store.readShadow(board, 'claim');
  assert.equal(counts.disagreed, 1);
  assert.equal(counts.last[0].differs, 'events.0.by');
});
