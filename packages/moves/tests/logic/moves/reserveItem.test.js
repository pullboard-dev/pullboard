/** reserveItem records a structured item reservation and an older engine refuses it [C7]. */
// fixture-subject: addItem (a store unit test of reserveItem over one seeded item; the board is a private cell fixture)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { RESERVATION_ENGINE } from '../../../../state/light.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
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

test('moves.reserve-item.records-holder-by-at-and-replaces: clause 1: reserveItem records holder, by and at, and a second reservation replaces the first [C7]', t => {
  const { board, id } = reservable(t);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  const first = store.getItem(board, id);
  assert.equal(first.item_reservation_holder, 'web-1');
  assert.equal(first.item_reservation_by, 'coordinator');
  assert.ok(first.item_reservation_at);
  store.reserveItem(board, id, { agentId: 'coordinator', holder: 'api-2' });
  const second = store.getItem(board, id);
  assert.equal(second.item_reservation_holder, 'api-2');
  assert.equal(second.item_status, first.item_status);
});

test('moves.reserve-item.older-engine-refuses: clause 2: an engine below RESERVATION_ENGINE refuses reserveItem with ENGINE_VERSION [C7]', t => {
  const { board, id } = reservable(t);
  board.executionEngineVersion = RESERVATION_ENGINE - 1;
  assert.throws(() => store.reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' }), { code: 'ENGINE_VERSION' });
  assert.equal(store.getItem(board, id).item_reservation_holder, null);
});
