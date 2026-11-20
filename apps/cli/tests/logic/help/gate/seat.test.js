/** next never hands out an item whose gate was red only on main reds [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../../packages/jobs/index.js';
import { addItem } from '../../../../../../packages/store/index.js';
import { nextFor } from '../../../../../../packages/store/index.js';
import { fixtureBoard } from '../../../fixtures/board.js';

const HEAD = 'a'.repeat(40);

test('cli.logic-help-gate-seat.next-does-not-hand-out-an-item: clause 2: next does not hand out an item whose last gate was red only on main reds, and still offers one red on its own cases [test] [C7]', t => {
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
