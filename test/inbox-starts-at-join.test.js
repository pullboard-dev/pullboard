/** A seat's inbox starts at its join, never at the board's first shout [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';
import { join } from 'node:path';
import { fixture as dispatchFixture } from './next-take-fixture.js';
import { main } from './native-cli-fixture.js';

test('clause 1: a seat that joins now reports 0 unread until a later shout reaches it [C7]', () => {
  let cleanup;
  const board = fixtureBoard({ after: callback => { cleanup = callback; } });
  try {
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
  } finally { cleanup?.(); }
});

/** Capture the actual next command's human output without acknowledging its inbox preview. */
async function nextAnswer(box, cwd) {
  let out = '', err = '';
  const code = await main(['next', '--build'], { cwd, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

test('clause 2: native next omits pre-join unread counts and reports genuine post-join mail [C7]', async t => {
  const box = await dispatchFixture(t);
  store.shout(box.board, { from: 'coordinator', to: 'all', text: 'history before the fresh seat joined' });
  const path = join(box.root, '..', 'fresh-inbox-seat');
  box.git(box.root, 'worktree', 'add', '-q', '-b', 'web/fresh-inbox-seat', path);
  const seat = store.register(box.board, { lane: 'web', path, route: 'strong', family: 'Family Alpha', parent: 'fixture-fresh-inbox' });
  store.heartbeatSeat(box.board, seat);
  box.add('A real item for the new inbox seat');
  const before = await nextAnswer(box, path);
  assert.equal(before.code, 0, before.text);
  assert.doesNotMatch(before.text, /\d+ unread messages?|history before the fresh seat joined/u);
  store.shout(box.board, { from: 'coordinator', to: seat, text: 'new message after the join' });
  const after = await nextAnswer(box, path);
  assert.equal(after.code, 0, after.text);
  assert.match(after.text, /1 unread message/u);
  assert.match(after.text, /new message after the join/u);
  assert.doesNotMatch(after.text, /history before the fresh seat joined/u);
});
