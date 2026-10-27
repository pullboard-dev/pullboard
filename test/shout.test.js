/** One worker reads its own session's directed messages across seats [B7,N2,N19]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Independent SQLite participants, including a helper whose parent is not its own session. */
function participants(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/worker-inbox/root' });
  const primary = store.register(board, { lane: 'web', path: '/worker-inbox/primary', session: 'worker-one' });
  const sibling = store.register(board, { lane: 'api', path: '/worker-inbox/sibling', session: 'worker-one' });
  const child = store.register(board, { lane: 'web', path: '/worker-inbox/child', parent: 'worker-one', session: 'helper-one' });
  const outsider = store.register(board, { lane: 'api', path: '/worker-inbox/outsider', session: 'worker-two' });
  const legacy = store.register(board, { lane: 'web', path: '/worker-inbox/legacy' });
  const otherLegacy = store.register(board, { lane: 'web', path: '/worker-inbox/other-legacy' });
  /** Send through the actual board move without changing an acknowledgement. */
  const send = (to, text) => store.shout(board, { from: 'coordinator', to, text, lanes: ['coordinator', 'web', 'api'] });
  return { board, primary, sibling, child, outsider, legacy, otherLegacy, send };
}

test('directed messages and readonly previews reach every seat of the same worker [B7,N19]', t => {
  const f = participants(t);
  const first = f.send(f.primary, 'First seat instruction');
  const second = f.send(f.sibling, 'Second seat instruction');
  const cursors = () => [f.primary, f.sibling].map(id => store.agentById(f.board, id).agent_last_shout_id);
  const before = cursors();
  for (const id of [f.primary, f.sibling]) {
    assert.deepEqual(store.inbox(f.board, id, { markRead: false }).map(row => row.shout_id), [first, second]);
    assert.equal(store.unreadCount(f.board, id), 2);
    assert.deepEqual(store.peekShouts(f.board, id, 10).map(row => row.shout_id), [first, second]);
    const activity = store.agentActivity(f.board, id);
    assert.deepEqual(activity.entries.filter(row => row.shout).map(row => row.shout), [first, second]);
  }
  assert.deepEqual(cursors(), before, 'a preview never acknowledges either seat');
});

test('a common parent does not share a helper inbox and unknown sessions stay separate [B7,B3]', t => {
  const f = participants(t);
  const own = f.send(f.primary, 'Only the parent worker');
  const helper = f.send(f.child, 'Only the separate helper');
  const unknown = f.send(f.legacy, 'Only this legacy seat');
  assert.deepEqual(store.inbox(f.board, f.child, { markRead: false }).map(row => row.shout_id), [helper]);
  assert.deepEqual(store.inbox(f.board, f.outsider, { markRead: false }), []);
  assert.deepEqual(store.inbox(f.board, f.otherLegacy, { markRead: false }), []);
  assert.deepEqual(store.inbox(f.board, f.legacy, { markRead: false }).map(row => row.shout_id), [unknown]);
  assert.deepEqual(store.inbox(f.board, f.primary, { markRead: false }).map(row => row.shout_id), [own]);
});

/** Run one actual CLI command in a private fixture session, never the operational session. */
function inSession(box, session, root, ...args) {
  const previous = box.env.CLAUDE_CODE_SESSION_ID;
  box.env.CLAUDE_CODE_SESSION_ID = session;
  try { return box.run(root, ...args); }
  finally {
    if (previous === undefined) delete box.env.CLAUDE_CODE_SESSION_ID;
    else box.env.CLAUDE_CODE_SESSION_ID = previous;
  }
}

/** Require a successful native fixture command before inspecting its document. */
function document(result) {
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

test('next and status surface directed instructions sent to another seat of this worker [B7,N2]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const web = join(box.dir, 'worker-web');
  const api = join(box.dir, 'worker-api');
  const session = 'private-worker-inbox-session';
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', web, 'main');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', api, 'main');
  const first = document(inSession(box, session, web, 'join', 'web', '--json'));
  document(inSession(box, session, api, 'join', 'api', '--json'));
  document(box.run(box.repo, 'add', 'api', 'Read the worker instruction', '--specs', 'G2',
    '--criterion', 'The result exists', '--check', 'test -f api/result.txt', '--wait', '--json'));
  document(box.run(box.repo, 'shout', first.agent, 'Shared worker instruction', '--json'));
  const status = document(inSession(box, session, api, 'status', '--json'));
  const next = inSession(box, session, api, 'next');
  assert.equal(next.code, 0, next.err || next.out);
  assert.equal(status.unread, 1, 'status counts the instruction addressed to the other seat');
  assert.match(next.out, /Shared worker instruction/, 'next surfaces the actual directed instruction');
});
