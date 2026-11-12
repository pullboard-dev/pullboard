/** A red submit gate keeps its item with the seat that built it, and next never hands out an item red only on main reds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureCompletion } from '../../../../src/io/submit/handoff/worker.js';
import { recordSubmitHandoff } from '../../../../../../packages/jobs/index.js';
import { addItem } from '../../../../../../packages/store/index.js';
import { nextFor } from '../../../../../../packages/store/index.js';
import { fixtureBoard } from '../../../fixtures/board.js';

const HEAD = 'a'.repeat(40);
const JOB = { id: 'job-1', agentId: 'web-1' };
const FAILURE = { code: 1, error: { code: 'GATE_RED', message: 'red', next: 'fix it' } };
const CONFIG = { claim: { reopenFirstRefusalMinutes: 30, returnToBoard: true } };

test('clause 1: a red gate result is recorded without returnToBoard, so the item stays with its seat even when claim.returnToBoard is on [test] [C7]', () => {
  const kept = failureCompletion(CONFIG, JOB, FAILURE, true);
  assert.equal(kept.returnToBoard, undefined, 'a red gate never gives the claim back to the board');
  assert.equal(kept.agentId, 'web-1');
  assert.equal(kept.job, 'job-1');
  assert.deepEqual(kept.result, FAILURE);
});

test('clause 1: a failed driver still returns the claim to the board when claim.returnToBoard is on, and not when it is off [test] [C7]', () => {
  assert.equal(failureCompletion(CONFIG, JOB, FAILURE, false).returnToBoard, true);
  assert.equal(failureCompletion({ claim: { returnToBoard: false } }, JOB, FAILURE, false).returnToBoard, undefined);
  assert.equal(failureCompletion({}, JOB, FAILURE, false).returnToBoard, undefined);
});

test('clause 2: next does not hand out an item whose last gate was red only on main reds, and still offers one red on its own cases [test] [C7]', t => {
  const board = fixtureBoard(t);
  const make = title => addItem(board, { by: 'coordinator', lane: 'web', title });
  const observe = (id, job) => {
    board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(HEAD, id);
    recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: HEAD, agentId: 'web-1', ...job });
  };
  const onMain = make('red only on main');
  observe(onMain, { state: 'red', error: { code: 'GATE_RED', mainRedOnly: true } });
  const result = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(result.item, null, 'nothing is offered while the only open item is red only on main');
  assert.ok(result.reasons.includes(`#${onMain}: gate red only on main reds at ${HEAD.slice(0, 12)}; nothing to build`), result.reasons.join(' | '));
  const own = make('red on its own cases');
  observe(own, { state: 'red', error: { code: 'GATE_RED' } });
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item.item_id, own, 'a red the item caused is still offered');
});
