/** When the item a 'superseded by' or 'duplicate of' request names lands, the requesting item is withdrawn with that reason [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { postLandSuite } from '../../../../packages/landing/index.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';

/** A real in-memory board with the coordinator and a builder, and a landing state whose batch landed the given ids. */
function fixture(t, landed) {
  const board = openCellBoard(':memory:', { now: () => new Date('2026-11-12T10:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = cellSeat(board, { lane: 'web', path: '/builder' });
  const said = [];
  const state = { board, config: { lanes: {} }, say: line => said.push(line),
    batch: { id: 'b1', base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/nowhere', items: landed.map(id => ({ id })) },
    write: async (operation, args) => store[operation](board, ...args) };
  const item = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], route: 'strong', criterion: '1. It works. [test]' }).item_id;
  const request = (id, note) => store.fileTypedRequest(board, { agentId: builder.id, verb: 'withdraw', itemId: id, cause: 'design-choice', note });
  return { board, state, said, item, request };
}

test('clause 1: a landed replacement withdraws the item a superseded-by request names, with that reason [C7]', async t => {
  const { board, state, item, request } = fixture(t, []);
  const old = item('Old way');
  const replacement = item('New way');
  state.batch.items = [{ id: replacement }];
  request(old, `superseded by #${replacement}`);
  await postLandSuite(state, undefined);
  const row = store.getItem(board, old);
  assert.equal(row.item_status, 'withdrawn');
  assert.match(row.item_withdrawn_reason, new RegExp(`superseded by #${replacement}`, 'u'));
  assert.equal(store.typedRequests(board, { all: true })[0].status, 'done', 'the request is answered');
});

test('clause 1: a landed original withdraws the item a duplicate-of request names [C7]', async t => {
  const { board, state, item, request } = fixture(t, []);
  const copy = item('Copy');
  const original = item('Original');
  state.batch.items = [{ id: original }];
  request(copy, `Duplicate of #${original}`);
  await postLandSuite(state, undefined);
  assert.match(store.getItem(board, copy).item_withdrawn_reason, new RegExp(`duplicate of #${original}`, 'u'));
});

test('clause 1: nothing is withdrawn while the named replacement has not landed [C7]', async t => {
  const { board, state, item, request } = fixture(t, []);
  const old = item('Old way');
  const replacement = item('New way');
  const other = item('Unrelated landing');
  state.batch.items = [{ id: other }];
  request(old, `superseded by #${replacement}`);
  await postLandSuite(state, undefined);
  assert.equal(store.getItem(board, old).item_status, 'open');
  assert.equal(store.typedRequests(board)[0].status, 'open');
});
