/** @pullboard-test-input packages/store/src/io/needs.js packages/store/src/io/board/add.js packages/store/src/io/board/edit.js packages/store/src/logic/board/item/lookup.js */
/** An item records a needs list through add and edit, and itemById reads it, over a real SQLite board [U136,C7,#1888]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../index.js';
import { ENGINE_VERSION } from '../../../state/light.js';
import { NEEDS_ENGINE } from '../../../state/light.js';
import { saveItemNeeds } from '../../src/io/needs.js';
import { validateItemNeeds } from '../../src/io/needs.js';
import { cellBoard } from '../fixtures/cell.js';
import { cellProject } from '../fixtures/cell.js';

/** A real project and board with a coordinator. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  return board;
}

test('store.needs.save-and-read: saveItemNeeds then itemById returns the needs; an item never given needs reads []; saving [] clears it [C7,U136]', (t) => {
  assert.ok((ENGINE_VERSION) >= NEEDS_ENGINE, 'a new board runs the current engine');
  const board = fixture(t);
  // fixture-subject: addItem
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Needs read', route: 'strong' });
  assert.deepEqual(store.itemById(board, id).item_needs, []);
  saveItemNeeds(board, id, ['browser']);
  assert.deepEqual(store.itemById(board, id).item_needs, ['browser']);
  saveItemNeeds(board, id, undefined);
  assert.deepEqual(store.itemById(board, id).item_needs, ['browser']);
  saveItemNeeds(board, id, []);
  assert.deepEqual(store.itemById(board, id).item_needs, []);
});

test('store.needs.refuse-unknown-and-old-engine: validateItemNeeds refuses an unknown need with USAGE naming browser and gui, and addItem refuses needs below NEEDS_ENGINE with ENGINE_VERSION [C7,U136]', (t) => {
  assert.throws(() => validateItemNeeds(['gpu']), (error) => error.code === 'USAGE' && /browser/u.test(error.message) && /gui/u.test(error.message));
  validateItemNeeds(undefined);
  validateItemNeeds(['browser', 'gui']);
  const board = fixture(t);
  const current = board.executionEngineVersion;
  try {
    board.executionEngineVersion = NEEDS_ENGINE - 1;
    assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Old engine', route: 'strong', needs: ['gui'] }), { code: 'ENGINE_VERSION' });
  } finally { board.executionEngineVersion = current; }
});

test('store.needs.add-real-path: the exported addItem and editItem record the needs list that itemById reads back [C7,U136]', (t) => {
  const board = fixture(t);
  // fixture-subject: addItem
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'With needs', route: 'strong', needs: ['browser', 'gui'] });
  assert.deepEqual(store.itemById(board, id).item_needs, ['browser', 'gui']);
  store.editItem(board, id, { agentId: 'coordinator', needs: ['gui'] });
  assert.deepEqual(store.itemById(board, id).item_needs, ['gui']);
  store.editItem(board, id, { agentId: 'coordinator', needs: [] });
  assert.deepEqual(store.itemById(board, id).item_needs, []);
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', needs: ['gpu'] }), { code: 'USAGE' });
});
