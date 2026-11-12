/** One worker reads its own session's directed messages across seats [B7,N2,N19]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { shoutMatchesAudience } from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

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

test('one worker acknowledges both seats, preserves later mail, and suppresses its own aliases [B7,R2]', t => {
  const f = participants(t);
  const first = f.send(f.primary, 'Acknowledge this snapshot');
  const second = f.send(f.sibling, 'Keep later mail pending');
  store.shout(f.board, { from: f.primary, to: f.sibling, text: 'Self mail', lanes: ['coordinator', 'web', 'api'] });
  store.shout(f.board, { from: f.sibling, to: 'all', text: 'Another self alias', lanes: ['coordinator', 'web', 'api'] });
  assert.deepEqual(store.inbox(f.board, f.sibling, { through: first }).map(row => row.shout_id), [first]);
  for (const id of [f.primary, f.sibling]) {
    assert.equal(store.agentById(f.board, id).agent_last_shout_id, first);
    assert.equal(store.unreadCount(f.board, id), 1);
    assert.deepEqual(store.inbox(f.board, id, { markRead: false }).map(row => row.shout_id), [second]);
  }
  assert.deepEqual(store.inbox(f.board, f.primary).map(row => row.shout_id), [second]);
  assert.deepEqual(store.inbox(f.board, f.sibling), []);
  store.inbox(f.board, f.primary, { through: first });
  // A full read moves the cursor past the self-alias shouts no seat receives, to the newest shout (441d31cb3d, #2480).
  const newest = f.board.db.prepare('SELECT MAX(shout_id) AS id FROM shout').get().id;
  assert.equal(store.agentById(f.board, f.primary).agent_last_shout_id, newest, 'an older snapshot never rolls acknowledgement back');
  assert.equal(shoutMatchesAudience(f.board.db, f.primary, new Set([f.sibling])), false, 'watch --to remains an explicit seat filter');
});

test('a legacy cursor on another alias cannot hide its older directed message [B7,N19]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/uneven/root' });
  const primary = store.register(board, { lane: 'web', path: '/uneven/one', session: 'uneven-worker' });
  const sibling = store.register(board, { lane: 'api', path: '/uneven/two' });
  const pending = store.shout(board, { from: 'coordinator', to: sibling, text: 'Not yet read', lanes: ['coordinator', 'web', 'api'] });
  const first = store.shout(board, { from: 'coordinator', to: primary, text: 'Already read', lanes: ['coordinator', 'web', 'api'] });
  store.inbox(board, primary);
  store.register(board, { lane: 'api', path: '/uneven/two', session: 'uneven-worker' });
  assert.deepEqual(store.inbox(board, primary).map(row => row.shout_id), [pending]);
  assert.deepEqual(store.inbox(board, sibling), []);
  assert.equal(store.agentById(board, primary).agent_last_shout_id, first);
  // The worker's read moves every alias to the same newest shout, once the older one was delivered (441d31cb3d, #2480).
  assert.equal(store.agentById(board, sibling).agent_last_shout_id, first);
});

test('activity freezes the worker inbox before a later sibling message arrives [B7,R2]', t => {
  const f = participants(t);
  const first = f.send(f.primary, 'Present at snapshot');
  let later;
  const activity = store.agentActivity(f.board, f.sibling, { workingFiles: () => {
    later = f.send(f.sibling, 'Arrived during observation');
    return [];
  } });
  assert.deepEqual(activity.entries.filter(row => row.shout).map(row => row.shout), [first]);
  assert.deepEqual(store.inbox(f.board, f.sibling, { through: activity.shoutCursor }).map(row => row.shout_id), [first]);
  assert.deepEqual(store.inbox(f.board, f.primary, { markRead: false }).map(row => row.shout_id), [later]);
});

test('lane and item messages follow worker aliases without granting a helper the same audience [B7]', t => {
  const f = participants(t);
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'api', title: 'Sibling item' });
  store.claim(f.board, id, { agentId: f.sibling, lane: 'api', leaseMs: 3_600_000,
    freeze: () => ({ text: 'Sibling item', digest: 'sibling-item' }) });
  const lane = f.send('api', 'Lane instruction');
  const item = store.shout(f.board, { from: 'coordinator', to: 'api', item: id,
    text: 'Item instruction', lanes: ['coordinator', 'web', 'api'] });
  assert.deepEqual(store.inbox(f.board, f.primary, { markRead: false }).map(row => row.shout_id), [lane, item]);
  assert.deepEqual(store.inbox(f.board, f.child, { markRead: false }), []);
  assert.deepEqual(store.inbox(f.board, f.outsider, { markRead: false }).map(row => row.shout_id), [lane]);
  // A single seat counts only the item shouts naming an item it holds; the coordinator holds every item [C7].
  assert.equal(store.unreadCount(f.board, f.outsider), 1, 'the outsider counts the lane message, never the item shout');
  const reply = store.shout(f.board, { from: f.sibling, to: 'api', item: id, text: 'Item reply', lanes: ['coordinator', 'web', 'api'] });
  assert.equal(store.unreadCount(f.board, 'coordinator'), store.inbox(f.board, 'coordinator', { markRead: false }).length);
  assert.ok(store.inbox(f.board, 'coordinator', { markRead: false }).some(row => row.shout_id === reply), 'the coordinator reads an item shout');
  // Only an exact item target counts: a number with trailing text, an unknown item and a bare prefix name no item [C7].
  const before = store.unreadCount(f.board, 'coordinator');
  const insert = f.board.db.prepare("INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, 'Malformed target', '2026-01-01T00:00:00.000Z')");
  for (const to of [`item:${id}x`, `item:${id + 1000}`, 'item:', `item:0${id}`]) insert.run(f.sibling, to);
  assert.equal(store.unreadCount(f.board, 'coordinator'), before, 'a target that is not exactly item:<id> reaches no seat, the coordinator included');
});

/** Run one actual CLI command in a private fixture session, never the operational session. */
async function inSession(box, session, root, ...args) {
  const previous = box.env.CLAUDE_CODE_SESSION_ID;
  box.env.CLAUDE_CODE_SESSION_ID = session;
  try { return await box.runIn(root, ...args); }
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

test('next and status surface directed instructions sent to another seat of this worker [B7,N2]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const web = join(box.dir, 'worker-web');
  const api = join(box.dir, 'worker-api');
  const session = 'private-worker-inbox-session';
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', web, 'main');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', api, 'main');
  const first = document(await inSession(box, session, web, 'join', 'web', '--route', 'strong', '--json'));
  // An unrouted item is strong, so both seats of the worker join strong and `next` has a takeable item.
  document(await inSession(box, session, api, 'join', 'api', '--route', 'strong', '--json'));
  document(await fixtureAdd(box.runIn, box.repo, 'api', 'Read the worker instruction', '--specs', 'G2',
    '--criterion', 'The result exists', '--check', 'test -f api/result.txt', '--wait', '--json'));
  document(await box.runIn(box.repo, 'shout', first.agent, 'Shared worker instruction', '--json'));
  const status = document(await inSession(box, session, api, 'status', '--json'));
  const next = await inSession(box, session, api, 'next');
  assert.equal(next.code, 0, next.err || next.out);
  assert.equal(status.unread, 1, 'status counts the instruction addressed to the other seat');
  assert.match(next.out, /Shared worker instruction/, 'next surfaces the actual directed instruction');
});
