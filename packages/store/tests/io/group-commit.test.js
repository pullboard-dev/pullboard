/** The board write queue commits several queued commands in one transaction and isolates a failing one [C7,#8926]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomic } from '../../index.js';
import { fixture } from '../fixtures/dispatch.js';
import { createWriteQueue } from '../../src/io/write-queue.js';

/** A queue over the real fixture board, counting the transactions it opens. */
function groupQueue(t) {
  const { board } = fixture(t);
  const opened = { transactions: 0, savepoints: 0 };
  const queue = createWriteQueue({
    transaction: work => { opened.transactions++; return atomic(board, work); },
    savepoint: work => { opened.savepoints++; return atomic(board, work); },
  });
  const put = (key, value) => board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(key, value);
  const has = key => board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value;
  return { queue, opened, put, has };
}

test('store.io-group-commit.several-commands-queued-together-are-committed: clause 1: several commands queued together are committed in one transaction, in submission order [C7,#8926]', async t => {
  const { queue, opened, put, has } = groupQueue(t);
  const order = [];
  const jobs = ['a', 'b', 'c'].map(name => queue.submit(() => { order.push(name); put(`group-${name}`, name); return name; }));
  assert.deepEqual(await Promise.all(jobs), ['a', 'b', 'c']);
  assert.equal(opened.transactions, 1, 'three queued commands share one transaction');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(['a', 'b', 'c'].map(name => has(`group-${name}`)), ['a', 'b', 'c']);
  assert.equal(queue.pending(), 0);
  await queue.submit(() => put('group-d', 'd'));
  assert.equal(opened.transactions, 2, 'a later command opens its own transaction');
});

test('store.io-group-commit.one-failing-command-in-a-group: clause 2: one failing command in a group rolls back only itself and the rest commit [C7,#8926]', async t => {
  const { queue, put, has } = groupQueue(t);
  const first = queue.submit(() => { put('keep-1', '1'); });
  const bad = queue.submit(() => { put('lose-me', 'x'); throw new Error('boom'); });
  const last = queue.submit(() => { put('keep-2', '2'); return 'ok'; });
  await first;
  await assert.rejects(bad, /boom/u);
  assert.equal(await last, 'ok');
  assert.equal(has('keep-1'), '1');
  assert.equal(has('keep-2'), '2');
  assert.equal(has('lose-me'), undefined, 'the failing command left no row');
});
