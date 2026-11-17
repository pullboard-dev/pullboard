/** A seat's inbox starts at its join, never at the board's first shout [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

test('board.inbox.seat-that-joins-now-reports-0: clause 1: a seat that joins now reports 0 unread until a later shout reaches it [C7]', t => {
  const board = cellBoard(t, ':memory:');
  store.register(board, { lane: 'coordinator', path: '/join/root' });
  store.shout(board, { from: 'coordinator', to: 'all', text: 'old shout before the join' });
  const seat = store.register(board, { lane: 'web', path: '/join/seat' });
  assert.deepEqual(store.inbox(board, seat, { markRead: false }), []);
  assert.equal(store.unreadCount(board, seat), 0);
  store.shout(board, { from: 'coordinator', to: 'all', text: 'shout after the join' });
  const unread = store.inbox(board, seat, { markRead: false });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].shout_text, 'shout after the join');
  assert.equal(store.unreadCount(board, seat), 1);
  store.register(board, { lane: 'web', path: '/join/seat' });
  assert.equal(store.unreadCount(board, seat), 1, 'rejoining never acknowledges genuine post-join mail');
});
