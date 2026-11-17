/** Queued inbox delivery marks flush in one batched write that only ever raises a seat's mark [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../../../../store/index.js';
import { register } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const mark = (board, agentId) => board.db.prepare('SELECT agent_last_shout_id AS m FROM agent WHERE agent_id=?').get(agentId).m;

/** Counts the transactions a callback opens by watching the board's COMMIT statements. */
function countWrites(board, run) {
  const real = board.db.exec.bind(board.db);
  let begins = 0;
  board.db.exec = sql => { if (/^\s*(COMMIT|RELEASE)/i.test(sql)) begins++; return real(sql); };
  try { run(); } finally { board.db.exec = real; }
  return begins;
}

test('clause 1: a queue of marks for several agents flushes in one transaction writing each agent\'s highest mark once [C7]', t => {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/m/root' });
  const a = register(board, { lane: 'web', path: '/m/a' });
  const b = register(board, { lane: 'web', path: '/m/b' });
  const c = register(board, { lane: 'web', path: '/m/c' });
  for (let i = 0; i < 9; i++) store.shout(board, { from: 'coordinator', to: 'all', text: `shout ${i}` });
  store.enqueueInboxMark(board, a, 3);
  store.enqueueInboxMark(board, a, 7);
  store.enqueueInboxMark(board, a, 5);
  store.enqueueInboxMark(board, b, 4);
  store.enqueueInboxMark(board, c, 2);
  assert.equal(mark(board, a), 0, 'a queued mark writes nothing yet');
  let written;
  const begins = countWrites(board, () => { written = store.flushInboxMarks(board); });
  assert.equal(written, 3, 'one write per agent');
  assert.equal(begins, 1, 'one transaction for the whole queue');
  assert.deepEqual([mark(board, a), mark(board, b), mark(board, c)], [7, 4, 2]);
  assert.equal(store.flushInboxMarks(board), 0, 'a flush empties the queue');
});

test('clause 2: a flush never lowers a recorded mark and an empty queue writes nothing [C7]', t => {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/m/root' });
  const a = register(board, { lane: 'web', path: '/m/a' });
  for (let i = 0; i < 9; i++) store.shout(board, { from: 'coordinator', to: 'all', text: `shout ${i}` });
  store.enqueueInboxMark(board, a, 8);
  store.flushInboxMarks(board);
  store.enqueueInboxMark(board, a, 2);
  store.flushInboxMarks(board);
  assert.equal(mark(board, a), 8, 'a later, lower mark leaves the recorded one');
  assert.equal(countWrites(board, () => assert.equal(store.flushInboxMarks(board), 0)), 0, 'an empty queue opens no transaction');
  assert.throws(() => store.enqueueInboxMark(board, a, -1), { code: 'BAD_ACTIVITY_CURSOR' });
});
