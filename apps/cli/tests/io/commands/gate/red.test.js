/** A red gate reads "(back with builder)" in list and show, and status counts it under that stage, until the next submit [F5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../../../packages/jobs/index.js';
import { itemLine } from '../../../../src/io/read.js';
import { fixtureBoard } from '../../../fixtures/board.js';

const COMMIT = 'c'.repeat(40);

/** A board with one open item whose frozen bar is `digest`, ready for a gate job to be recorded against it. */
function redFixture(t) {
  const board = fixtureBoard(t);
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Red gate state' }); // fixture-subject: addItem
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  return { board, id };
}

/** Record the item's gate job in `state`. */
function gate(board, id, state, extra = {}) {
  recordSubmitHandoff(board.db, id, { version: 1, id: `job-${state}`, agentId: 'core-1', commit: COMMIT, digest: 'digest', state, ...extra });
}

test('clause 1: list and show print (back with builder) for an item whose last gate was red, until the next submit [F5]', t => {
  const { board, id } = redFixture(t);
  gate(board, id, 'red', { error: { code: 'GATE_RED', message: 'The proof is red.', next: 'Fix it.' } });
  const listed = store.listItems(board).find(item => item.item_id === id);
  const shown = store.getItem(board, id);
  for (const item of [listed, shown]) {
    assert.equal(item.item_stage, 'back with builder');
    assert.match(itemLine(item), /\(back with builder\)/);
    assert.doesNotMatch(itemLine(item), /\(building\)/);
  }
  gate(board, id, 'queued');
  assert.doesNotMatch(itemLine(store.getItem(board, id)), /back with builder/, 'the next submit ends the red state');
});

test('clause 2: status counts that item under back with builder, and stops counting it after the next submit [F5]', t => {
  const { board, id } = redFixture(t);
  assert.equal(store.stats(board).stages['back with builder'], 0);
  gate(board, id, 'red');
  assert.equal(store.stats(board).stages['back with builder'], 1);
  gate(board, id, 'queued');
  assert.equal(store.stats(board).stages['back with builder'], 0);
});
