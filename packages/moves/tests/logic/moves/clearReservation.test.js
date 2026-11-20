/** clearReservation removes an item reservation, refuses when none is set, and an older engine refuses it [C7,#9176]. */
// fixture-subject: addItem (a store unit test of clearReservation over one seeded item; the board is a private cell fixture)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { RESERVATION_ENGINE } from '../../../../state/light.js';

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

test('moves.clear-reservation.removes-set-reservation: clause 1: clearReservation after reserveItem on one open item reads the reservation holder, actor and instant back as null [C7]', t => {
  const { board, id } = reservable(t);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  assert.equal(snapshot(board, id).holder, 'web-1');
  assert.deepEqual(store.clearReservation(board, id, { agentId: 'coordinator' }), { holder: 'web-1' });
  assert.deepEqual(snapshot(board, id), { holder: null, by: null, at: null });
});

test('moves.clear-reservation.no-reservation-refused: clause 2: clearReservation on an item with no reservation refuses with a next step and leaves the item unchanged [C7]', t => {
  const { board, id } = reservable(t);
  const before = store.getItem(board, id);
  assert.throws(() => store.clearReservation(board, id, { agentId: 'coordinator' }), error => error.code === 'USAGE' && /see pullboard show/u.test(error.message));
  assert.deepEqual(store.getItem(board, id), before);
});

test('moves.clear-reservation.older-engine-refuses: clause 3: an engine below RESERVATION_ENGINE refuses clearReservation with ENGINE_VERSION [C7]', t => {
  const { board, id } = reservable(t);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  board.executionEngineVersion = RESERVATION_ENGINE - 1;
  assert.throws(() => store.clearReservation(board, id, { agentId: 'coordinator' }), { code: 'ENGINE_VERSION' });
  assert.equal(snapshot(board, id).holder, 'web-1');
});
