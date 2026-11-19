/** clearReservation removes an item reservation, refuses when none is set, and the event history shows both [C7,#9176]. */
// fixture-subject: addItem (a store unit test of clearReservation over one seeded item; the board is a private cell fixture)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** A private board with the coordinator seated and one open item. */
function reservable(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Reservable', route: 'mid',
    criterion: 'The private fixture proves the reservation.', brief: LIGHT_BRIEF, check: 'true' });
  return { board, id };
}

/** The reservation columns of an item, the way the board snapshot reads them. */
function snapshot(board, id) {
  const { item_reservation_holder: holder, item_reservation_by: by, item_reservation_at: at } = store.getItem(board, id);
  return { holder, by, at };
}

test('moves.clear-reservation.removes-and-refuses-when-none: clause 1: clearReservation removes an item reservation set by reserveItem and refuses with a next step when none is set [C7]', t => {
  const { board, id } = reservable(t);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  assert.equal(snapshot(board, id).holder, 'web-1');
  assert.deepEqual(store.clearReservation(board, id, { agentId: 'coordinator' }), { holder: 'web-1' });
  assert.deepEqual(snapshot(board, id), { holder: null, by: null, at: null });
  assert.throws(() => store.clearReservation(board, id, { agentId: 'coordinator' }), error => error.code === 'USAGE' && /nothing to clear; see pullboard show/u.test(error.message));
});

test('moves.clear-reservation.history-shows-both: clause 2: the item history records the reservation after reserveItem and its absence after clearReservation [C7]', t => {
  const { board, id } = reservable(t);
  const kinds = () => board.db.prepare("SELECT event_kind AS kind, event_detail AS detail FROM event WHERE item_id = ? AND event_kind IN ('reserve_item', 'clear_reservation') ORDER BY event_id").all(id);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  assert.deepEqual(kinds().map(row => row.kind), ['reserve_item']);
  assert.equal(snapshot(board, id).by, 'coordinator');
  store.clearReservation(board, id, { agentId: 'coordinator' });
  assert.deepEqual(kinds().map(row => row.kind), ['reserve_item', 'clear_reservation']);
  assert.equal(JSON.parse(kinds()[1].detail).holder, 'web-1', 'the clear event names the holder it removed');
  assert.equal(snapshot(board, id).holder, null);
});
