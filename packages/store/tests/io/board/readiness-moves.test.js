/** The add and edit moves record and replace an item readiness command, and replay gives the same one, over a real SQLite board [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { applyEngineMove } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';

/** A real project and board with a coordinator. */
function fixture(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  return board;
}

test('clause 1: addItem with a readiness command stores it on the item [C7,H16]', (t) => {
  const board = fixture(t);
  // fixture-subject: addItem
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'With readiness', route: 'strong', readinessCommand: '  node --version  ' });
  assert.equal(store.itemById(board, id).item_readiness_command, 'node --version');
  // fixture-subject: addItem
  const plain = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Without readiness', route: 'strong' });
  assert.equal(store.itemById(board, plain).item_readiness_command, '');
});

test('clause 2: editItem replaces the readiness command and an empty one clears it [C7,H16]', (t) => {
  const board = fixture(t);
  // fixture-subject: addItem
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Edit readiness', route: 'strong', readinessCommand: 'node --version' });
  // fixture-subject: editItem
  store.editItem(board, id, { agentId: 'coordinator', readinessCommand: 'git --version' });
  assert.equal(store.itemById(board, id).item_readiness_command, 'git --version');
  store.editItem(board, id, { agentId: 'coordinator', readinessCommand: '' });
  assert.equal(store.itemById(board, id).item_readiness_command, '');
});

test('clause 2: a readiness command too long is refused with BAD_READINESS [C7,H16]', (t) => {
  const board = fixture(t);
  assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Long', route: 'strong', readinessCommand: 'x'.repeat(501) }), { code: 'BAD_READINESS' });
});

test('clause 3: replaying the same move log on a second board gives the same readiness command [C7,H16]', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const at = '2026-11-16T10:00:00.000Z';
  const add = prepareEngineMove(first, 'addItem', [{ by: 'coordinator', lane: 'core', title: 'Replay readiness', route: 'strong', readinessCommand: 'node --version' }], { id: 'add-readiness' });
  const edit = prepareEngineMove(first, 'editItem', [1, { agentId: 'coordinator', readinessCommand: 'git --version' }], { id: 'edit-readiness' });
  const readings = [first, second].map((board) => {
    applyEngineMove(board, add, { sequence: 1, at });
    const afterAdd = store.itemById(board, 1).item_readiness_command;
    applyEngineMove(board, edit, { sequence: 2, at });
    return [afterAdd, store.itemById(board, 1).item_readiness_command];
  });
  assert.deepEqual(readings[0], ['node --version', 'git --version']);
  assert.deepEqual(readings[1], readings[0]);
});
