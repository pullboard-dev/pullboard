/** With moves.live.claim on, the claim writer writes the claim table's events and refuses what the table refuses; off, its own rules decide [C7,#8383]. */
/** @pullboard-test-input packages/store/src/io/board/claim.js packages/store/src/io/board/claim-table.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');

/** A board with one open core item and a seat registered in `seatLane` to claim it; `live` stands in for the moves.live.claim machine setting. */
function claimable(t, { live, seatLane = 'core' }) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  if (live !== undefined) board.movesLive = { claim: live };
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const seat = cellSeat(board, { lane: seatLane, path: '/seat/builder' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Live claim', criterion: '1. the claim is live [test].', route: 'strong', check: 'true' });
  const claim = () => store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 60 * 60_000, freeze: () => ({ text: 'frozen', digest: 'live-digest' }) });
  return { board, id, claim };
}

/** The item's claim, renew and fact events in order, without the stamped model or a fact's random id, which differ on every write. */
function eventsOf(board, id) {
  return board.db.prepare("SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE item_id=? AND event_kind IN ('claim', 'renew', 'fact') ORDER BY event_id").all(id)
    .map(({ kind, by, detail }) => ({ kind, by, detail: (({ model, id: factId, ...rest }) => rest)(JSON.parse(detail)) }));
}

test('clause 1: with moves.live.claim on, a claim writes exactly the events the claim table decides [C7,#8383]', t => {
  const shadowed = claimable(t, { live: false });
  let decided = null;
  shadowed.board.claimShadow = answer => { decided = answer.decided; };
  shadowed.claim();
  assert.ok(decided?.events?.length, 'the claim table decided at least the claim event');
  const live = claimable(t, { live: true });
  live.claim();
  const strip = ({ kind, by, detail }) => ({ kind, by, detail: (({ model, id, ...rest }) => rest)(detail) });
  assert.deepEqual(eventsOf(live.board, live.id), decided.events.map(strip));
});

test('clause 2: with moves.live.claim on, a claim the table refuses is refused with the table\'s code and writes nothing [C7,#8383]', t => {
  const { board, id, claim } = claimable(t, { live: true, seatLane: 'review' });
  const before = board.db.prepare('SELECT COUNT(*) n FROM event').get().n;
  assert.throws(claim, error => error.code === 'WRONG_LANE' && /review/u.test(error.message) && typeof error.next === 'string' && error.next.length > 0);
  assert.equal(board.db.prepare('SELECT COUNT(*) n FROM event').get().n, before, 'a refused claim writes no event');
  assert.equal(store.getItem(board, id).item_status, 'open');
});

test('clause 3: with moves.live.claim off (the default) the writer\'s own rules decide the same claim [C7,#8383]', t => {
  const { board, id, claim } = claimable(t, { live: undefined, seatLane: 'review' });
  claim();
  assert.equal(store.getItem(board, id).item_status, 'claimed', 'the writer accepted the claim the table refuses');
});
