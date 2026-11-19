/** The state the view serves and the native board state carry the same holds and itemHolds [C7,#3043]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createStateSnapshots } from '../../../../packages/api/index.js';
import { apiBoardOpeners } from '../../../cli/tests/fixtures/board.js';
import { viewApiPorts } from '../../src/io/ports.js';
import { projectState } from '../../src/io/serve.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** A real private board with a coordinator and one open item in the web lane. */
function machine(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const item = cellItem(board, { lane: 'web', title: 'Held item', route: 'mid', criterion: 'The private fixture proves the hold.', brief: LIGHT_BRIEF, check: 'true' }).item_id;
  return { project, board, item };
}

/** The two states of one board: the view's own projection and the native state the API builds. */
function both({ project, board }) {
  const snapshots = createStateSnapshots({ projects: () => [{ root: project.repo, name: 'Parity fixture' }], viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners });
  const native = snapshots.withSnapshot({ id: 'parity', root: project.repo }, (entry) => entry.state);
  return { view: projectState(project.repo, { board }), native };
}

test('view.x-io-holds-parity.clause-1-with-one-lane-hold-and: clause 1: with one lane hold and one item hold the view and native states carry equal holds and itemHolds [C7,#3043]', (t) => {
  const box = machine(t);
  store.holdLane(box.board, 'web', { agentId: 'coordinator', reason: 'freeze the web lane' });
  store.holdItem(box.board, box.item, { agentId: 'coordinator', reason: 'wait for the design' });
  const { view, native } = both(box);
  assert.equal(view.holds.length, 1, 'the view carries the lane hold');
  assert.equal(view.itemHolds.length, 1, 'the view carries the item hold');
  assert.deepEqual(native.holds, view.holds);
  assert.deepEqual(native.itemHolds, view.itemHolds);
});

test('view.x-io-holds-parity.clause-2-a-board-with-no-holds: clause 2: a board with no holds gives empty holds and itemHolds in both states [C7,#3043]', (t) => {
  const box = machine(t);
  const { view, native } = both(box);
  assert.deepEqual(view.holds, []);
  assert.deepEqual(view.itemHolds, []);
  assert.deepEqual(native.holds, []);
  assert.deepEqual(native.itemHolds, []);
});
