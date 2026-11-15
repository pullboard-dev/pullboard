/** A returned red shows only when its commit matches the item's current head [SM14]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { addItem } from '../../../../index.js';
import { returnedRecord } from '../../../../index.js';
import { fixtureBoard } from '../../../../../../apps/cli/tests/fixtures/board.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** Record a red gate at OLD for a fresh open item whose current head is `head`. */
function redAt(board, head) {
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: `red at ${head.slice(0, 4)}` });
  board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(head, id);
  recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: OLD, agentId: 'web-1', state: 'red', error: { code: 'TEST_FAILURE', message: 'boom', next: 'fix it' } });
  return id;
}

test('clause 1: returnedRecord shows a red gate only when its commit matches the item head [SM14]', (t) => {
  const board = fixtureBoard(t);
  const current = redAt(board, OLD);
  assert.equal(returnedRecord(board, current)?.gate?.commit, OLD, 'a red at the current head shows');
  const moved = redAt(board, NEW);
  assert.equal(returnedRecord(board, moved), null, 'a red from an older head does not show');
});
