/** An item carries a readiness command from its engine, empty by default, and older replays read as before, over a real SQLite board [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { ENGINE_VERSION } from '../../../../../state/light.js';
import { READINESS_ENGINE } from '../../../../../state/light.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';

/** A real project and board with one item added. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  // fixture-subject: addItem
  const item = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Readiness field', route: 'strong' });
  return { board, id: item };
}

test('board.readiness-field.board-the-new-engine-stores-item: clause 1: a board at the new engine stores an item readiness command, empty by default [C7,H16]', (t) => {
  const { board, id } = fixture(t);
  assert.ok((board.executionEngineVersion ?? ENGINE_VERSION) >= READINESS_ENGINE, 'a new board runs the current engine');
  const item = store.itemById(board, id);
  assert.equal(item.item_readiness_command, '');
  board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`item_readiness_command:${id}`, JSON.stringify('node --version'));
  assert.equal(store.itemById(board, id).item_readiness_command, 'node --version');
});

test('board.readiness-field.board-replayed-the-previous-engine-reads: clause 2: a board replayed at the previous engine reads the same as before [C7,H16]', (t) => {
  const { board, id } = fixture(t);
  board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`item_readiness_command:${id}`, JSON.stringify('node --version'));
  const current = board.executionEngineVersion;
  try {
    board.executionEngineVersion = READINESS_ENGINE - 1;
    const item = store.itemById(board, id);
    assert.equal(Object.hasOwn(item, 'item_readiness_command'), false);
    assert.equal(Object.hasOwn(item, 'readiness_command'), false);
  } finally { board.executionEngineVersion = current; }
});
