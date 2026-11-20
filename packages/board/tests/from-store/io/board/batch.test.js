/** @pullboard-test-input source-cell packages/board */
/** With landing.exactTreeCheck on, finishLandingBatch refuses a batch with no green exact-tree record inside its own write: RFC 0011 ET5, narrowed and approved 17 Nov 2026 [V16,V36]. */
// fixture-subject: addItem (a store unit test of finishLandingBatch over a seeded board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishLandingBatch } from '../../../../../store/index.js';
import * as store from '../../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell-board.js';

const BASE = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const AT = '2026-11-17T00:00:00.000Z';

/** A board holding one pushed batch, with the given exact-tree record on it. */
function pushed(t, exactTree) {
  const board = openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  const batch = { version: 1, id: 'batch-1', state: 'pushed', base: BASE, tip: TIP, branch: 'refs/heads/main', root: '/fixture/landing', owner: 'fixture',
    logPath: '/fixture/landing.log', candidates: [], items: [], revision: 0, ...(exactTree ? { exactTree } : {}) };
  store.recordLandingBatch(board, { agentId: 'coordinator', batch });
  return board;
}

const mainMoves = board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'main-moved'").get().n;
const stateOf = board => store.landingBatches(board).find(batch => batch.id === 'batch-1').state;

test('board.batch.exact-tree-check-refuses-unproved: clause 1: with exactTreeCheck true, finishLandingBatch refuses a batch with no exact-tree record or a red one, records no main-moved receipt and leaves the batch pushed [V16,V36]', t => {
  for (const exactTree of [undefined, { tree: TREE }, { tree: TREE, pin: 'tooling', cells: ['packages/store'], result: 'red', failed: 'packages/store' }]) {
    const board = pushed(t, exactTree);
    assert.throws(() => finishLandingBatch(board, { agentId: 'coordinator', id: 'batch-1', tip: TIP, exactTreeCheck: true }),
      error => error.code === 'LAND_EXACT_TREE' && /no green exact-tree record/u.test(error.message));
    assert.equal(mainMoves(board), 0, 'no main-moved receipt is recorded');
    assert.equal(stateOf(board), 'pushed', 'the batch is not marked landed');
  }
  const green = pushed(t, { tree: TREE, pin: 'tooling', cells: ['packages/store'], result: 'green' });
  assert.equal(finishLandingBatch(green, { agentId: 'coordinator', id: 'batch-1', tip: TIP, exactTreeCheck: true }).state, 'landed', 'a green record lets the same write through');
  assert.equal(mainMoves(green), 1);
});

test('board.batch.exact-tree-check-off-as-today: clause 2: with exactTreeCheck false or not given, finishLandingBatch records a batch with no exactTree as it does today [V16,V36]', t => {
  for (const args of [{}, { exactTreeCheck: false }]) {
    const board = pushed(t, undefined);
    assert.equal(finishLandingBatch(board, { agentId: 'coordinator', id: 'batch-1', tip: TIP, ...args }).state, 'landed');
    assert.equal(mainMoves(board), 1);
  }
});
