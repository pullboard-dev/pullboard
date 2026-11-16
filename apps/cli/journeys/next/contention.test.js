/** Next contention: with queue.contention on, next steers away from files others are changing [C7,#8527,#1389]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { builderSeat } from '../../tests/fixtures/next/order.js';
import { filesItem } from '../../tests/fixtures/next/order.js';
import { takeItem } from '../../tests/fixtures/next/order.js';

const ask = (board, agentId, contention) => store.nextFor(board, { agentId, lane: 'core', ...(contention ? { contention } : {}) });

test('clause 1: with queue.contention on, next orders ready items of equal priority by contention score, lowest first [C7,#8527]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  takeItem(board, filesItem(board, 'Holder of the busy file', ['src/busy.js']), builderSeat(board, 'holder-busy'));
  takeItem(board, filesItem(board, 'Holder of the calm file', ['src/calm.js']), builderSeat(board, 'holder-calm'));
  const busy = filesItem(board, 'Older item on the busy file', ['src/busy.js']);
  const calm = filesItem(board, 'Newer item on the calm file', ['src/calm.js']);
  const rates = new Map([['src/busy.js', 3], ['src/calm.js', 1]]);
  assert.equal(ask(board, builder).item.item_id, busy, 'with the setting off the older item leads, as before');
  assert.equal(ask(board, builder, { threshold: 10, rates }).item.item_id, calm, 'on, the lower score (1 against 3) leads');
});

test('clause 2: an item whose contention score passes the threshold waits and next names the file it waits on [C7,#8527]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  takeItem(board, filesItem(board, 'Holder of the hot file', ['src/hot.js']), builderSeat(board, 'holder-hot'));
  const waiting = filesItem(board, 'Item on the hot file', ['src/hot.js']);
  const rates = new Map([['src/hot.js', 3]]);
  assert.equal(ask(board, builder).item.item_id, waiting, 'off, the overlapping item is still offered with its overlap noted');
  const answer = ask(board, builder, { threshold: 2, rates });
  assert.equal(answer.item, null, 'on, the item waits');
  assert.match(answer.reasons.join('\n'), new RegExp(`#${waiting} waits on src/hot\\.js`, 'u'), 'and next names the file');
});

test('clause 3: two items on one hot file never start together [C7,#8527]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const first = filesItem(board, 'First item on the hot file', ['src/hot.js']);
  const second = filesItem(board, 'Second item on the hot file', ['src/hot.js']);
  const contention = { threshold: 1, rates: new Map([['src/hot.js', 2]]) };
  assert.equal(ask(board, builder, contention).item.item_id, first, 'with nothing in flight the first starts');
  takeItem(board, first, builder);
  const other = builderSeat(board, 'second-seat');
  assert.equal(ask(board, other, contention).item, null, 'the second waits while the first is in flight');
  assert.equal(ask(board, other).item.item_id, second, 'off, the second would have started beside it');
});
