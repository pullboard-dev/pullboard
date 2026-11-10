/** Real SQLite item-message decision and validation controls [B7,B21,B27]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from "../../../../../src/io/board.js";
import { openCellBoard as openBoard } from "../../../../fixtures/cell.js";


test('item decisions authorize participants, retain their thread and can pass to the person [B7,B21,B27]', (t) => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  for (const [lane, path] of [['coordinator', '/item-root'], ['web', '/item-root/web-1'], ['web', '/item-root/web-2'], ['api', '/item-root/api-1']]) store.register(board, { lane, path });
  const lanes = ['coordinator', 'web', 'api'];
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Item decision' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * 3_600_000, freeze: () => ({ text: 'item decision', digest: 'digest:item-decision' }) });
  const ask = store.shout(board, { from: 'api-1', to: 'web', item: id, text: 'Choose the item direction', lanes, decision: true });
  assert.deepEqual(store.openDecisions(board, 'web-1').map(row => row.shout_id), [ask]);
  assert.deepEqual(store.openDecisions(board, 'web-2'), []);
  assert.throws(() => store.answerDecision(board, ask, { agentId: 'web-2', text: 'No standing', lanes }), /NOT_YOUR_DECISION/);
  const answer = store.answerDecision(board, ask, { agentId: 'web-1', text: 'Use the agreed direction', lanes });
  assert.equal(store.getShout(board, answer).shout_to, `item:${id}`);
  assert.equal(store.events(board, { itemId: id }).at(-1).event_kind, 'answer');
  assert.deepEqual(store.openDecisions(board, 'coordinator'), []);
  const second = store.shout(board, { from: 'web-1', to: 'coordinator', item: id, text: 'Person choice', lanes, decision: true });
  const passed = store.passDecision(board, second, { agentId: 'coordinator', note: 'Needs the person', lanes });
  assert.equal(store.getShout(board, passed).shout_to, 'person');
  store.answerDecision(board, passed, { agentId: 'coordinator', asPerson: true, text: 'Person chose', lanes });
  assert.equal(store.events(board, { itemId: id }).at(-1).event_kind, 'answer');
  assert.deepEqual(store.openDecisions(board), []);
  for (const item of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.shout(board, { from: 'web-1', to: 'web', item, text: 'invalid', lanes }), /BAD_SHOUT_ITEM/);
  }
  assert.throws(() => store.shout(board, { from: 'web-1', to: 'web', item: id + 1000, text: 'missing', lanes }), /NO_ITEM/);
});
