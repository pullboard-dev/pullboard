/**
 * The board's rules on an in-memory board with a hand-turned clock (B4–B7, V1, V2, V5, V6, V8, R1,
 * R2). The git-facing rules (V3, V4, V7) run against real repos in e2e.test.js.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as store from '../src/board.js';

const HOUR = 3_600_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
let board;
let clock;

/**
 * A freeze that digests the item's title, like the real one digests its criterion.
 */
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/**
 * Claim as an agent in its lane, with a 2-hour lease.
 */
const claimAs = (id, agentId, lane) => store.claim(board, id, { agentId, lane, leaseMs: 2 * HOUR, freeze });

beforeEach(() => {
  let at = Date.parse('2026-10-04T12:00:00Z');
  clock = { now: () => new Date(at), advance: (ms) => { at += ms; } };
  board = store.openBoard(':memory:', clock);
  store.register(board, { lane: 'coordinator', path: '/repo' });
  store.register(board, { lane: 'web', path: '/repo-web-1' });
  store.register(board, { lane: 'web', path: '/repo-web-2' });
  store.register(board, { lane: 'api', path: '/repo-api-1' });
});

test('agents are numbered per lane; one coordinator; a worktree joins once', () => {
  assert.deepEqual(store.listAgents(board).map((agent) => agent.agent_id), ['coordinator', 'web-1', 'web-2', 'api-1']);
  assert.equal(store.register(board, { lane: 'web', path: '/repo-web-1' }), 'web-1');
  assert.throws(() => store.register(board, { lane: 'api', path: '/repo-web-1' }), /ALREADY_JOINED/);
  assert.throws(() => store.register(board, { lane: 'coordinator', path: '/elsewhere' }), /ONE_COORDINATOR/);
});

test('the coordinator follows the main checkout when the repo moves', () => {
  assert.equal(store.ensureCoordinator(board, '/moved/repo'), 'coordinator');
  assert.equal(store.agentAt(board, '/moved/repo').agent_id, 'coordinator');
});

test('a claim is a lease: renewable by its holder, free again once it lapses [B4]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  assert.throws(() => claimAs(id, 'web-2', 'web'), /HELD/);
  assert.equal(claimAs(id, 'web-1', 'web').renewed, true);
  clock.advance(2 * HOUR + 1);
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(claimAs(id, 'web-2', 'web').renewed, false);
  assert.equal(store.getItem(board, id).item_owner, 'web-2');
});

test('one live top-level claim per agent; child items are free; lanes hold [B5]', () => {
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'One' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two' });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'One, part', parentId: first });
  const api = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Endpoint' });
  claimAs(first, 'web-1', 'web');
  assert.throws(() => claimAs(second, 'web-1', 'web'), /ONE_CLAIM/);
  claimAs(child, 'web-1', 'web');
  assert.throws(() => claimAs(api, 'web-1', 'web'), /WRONG_LANE/);
  claimAs(api, 'coordinator', 'coordinator');
  assert.throws(
    () => store.addItem(board, { by: 'web-1', lane: 'api', title: 'Cross', parentId: first }),
    /PARENT_LANE/,
  );
});

test('the first claim freezes the criterion; later claims keep it [V2]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  assert.equal(claimAs(id, 'web-1', 'web').digest, 'digest:Page');
  store.release(board, id, 'web-1');
  const other = (item) => ({ text: 'changed', digest: `other:${item.item_id}` });
  store.claim(board, id, { agentId: 'web-2', lane: 'web', leaseMs: HOUR, freeze: other });
  assert.equal(store.getItem(board, id).item_frozen_digest, 'digest:Page');
});

test('submit needs your claim and finished children', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Part', parentId: id });
  assert.throws(() => store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' }), /NOT_YOURS/);
  claimAs(id, 'web-1', 'web');
  assert.throws(() => store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' }), /CHILDREN_OPEN/);
  store.withdraw(board, child, { agentId: 'coordinator', reason: 'folded into the parent' });
  store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.equal(store.getItem(board, id).item_status, 'submitted');
});

/**
 * An item built by web-1 and submitted at SHA_A.
 */
function submitted() {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
  return id;
}

/**
 * A verdict with the defaults a correct verifier would pass.
 */
const verdict = (id, fields) =>
  store.verify(board, id, { head: SHA_A, digest: 'digest:Page', policy: 'any', ...fields });

test('the builder never verifies its own work [V1]', () => {
  const id = submitted();
  assert.throws(() => verdict(id, { agentId: 'web-1', decision: 'ACCEPT' }), /SELF_VERIFY/);
  assert.equal(verdict(id, { agentId: 'web-2', decision: 'ACCEPT' }).reason, 'CRITERION_MET');
});

test('under verify: coordinator, lane work is the coordinator\'s to verify', () => {
  const id = submitted();
  assert.throws(
    () => verdict(id, { agentId: 'web-2', decision: 'ACCEPT', policy: 'coordinator' }),
    /COORDINATOR_VERIFIES/,
  );
  verdict(id, { agentId: 'coordinator', decision: 'ACCEPT', policy: 'coordinator' });
});

test('a verdict against a moved criterion is refused [V2]', () => {
  const id = submitted();
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'ACCEPT', digest: 'digest:moved' }), /CRITERIA_CHANGED/);
  const result = store.refreeze(board, id, { agentId: 'coordinator', freeze: () => ({ text: 'x', digest: 'digest:moved' }) });
  assert.deepEqual(result, { before: 'digest:Page', after: 'digest:moved' });
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.throws(() => store.refreeze(board, id, { agentId: 'web-2', freeze }), /COORDINATOR_ONLY/);
});

test('ACCEPT needs CRITERION_MET; REJECT needs a reason code and a note [V5]', () => {
  const id = submitted();
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'ACCEPT', reason: 'OTHER' }), /BAD_REASON/);
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'REJECT' }), /BAD_REASON/);
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE' }), /NOTE_REQUIRED/);
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'MAYBE' }), /BAD_DECISION/);
});

test('REJECT reopens the item; resubmitting a rejected head is refused [V6]', () => {
  const id = submitted();
  verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'title missing' });
  const item = store.getItem(board, id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_verdict, 'REJECT');
  claimAs(id, 'web-1', 'web');
  assert.throws(() => store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' }), /HEAD_NOT_NEW/);
  store.submit(board, id, { agentId: 'web-1', commit: SHA_B, tree: 'tree-b' });
  verdict(id, { agentId: 'web-2', decision: 'ACCEPT' });
  assert.equal(store.getItem(board, id).item_status, 'verified');
});

test('every verdict binds the submitted commit and the frozen digest [V8]', () => {
  const id = submitted();
  verdict(id, { agentId: 'web-2', decision: 'ACCEPT', head: SHA_B });
  const [recorded] = store.verdictsFor(board, id);
  assert.equal(recorded.verdict_commit, SHA_A);
  assert.equal(recorded.verdict_digest, 'digest:Page');
  assert.equal(recorded.verdict_head, SHA_B);
  assert.throws(() => verdict(id, { agentId: 'api-1', decision: 'ACCEPT' }), /NOT_SUBMITTED/);
});

test('merged and withdraw are the coordinator\'s, and only for the right states', () => {
  const id = submitted();
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: SHA_B }), /NOT_VERIFIED/);
  verdict(id, { agentId: 'web-2', decision: 'ACCEPT' });
  assert.throws(() => store.merged(board, id, { agentId: 'web-2', commit: SHA_B }), /COORDINATOR_ONLY/);
  store.merged(board, id, { agentId: 'coordinator', commit: SHA_B });
  assert.equal(store.getItem(board, id).item_merged_commit, SHA_B);
  assert.throws(() => store.withdraw(board, id, { agentId: 'coordinator', reason: 'late' }), /CLOSED/);
});

test('shouts reach a lane, an agent or all; inbox marks them read [B7]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  store.shout(board, { from: 'coordinator', to: 'web', text: 'web: rebase', lanes });
  store.shout(board, { from: 'api-1', to: 'web-2', text: 'web-2: schema changed', lanes });
  store.shout(board, { from: 'web-1', to: 'all', text: 'all: gate is slow', lanes });
  assert.throws(() => store.shout(board, { from: 'web-1', to: 'nobody', text: 'x', lanes }), /NO_READER/);
  assert.equal(store.unreadCount(board, 'web-2'), 3);
  assert.deepEqual(store.inbox(board, 'web-2').map((shout) => shout.shout_text), ['web: rebase', 'web-2: schema changed', 'all: gate is slow']);
  assert.equal(store.unreadCount(board, 'web-2'), 0);
  assert.deepEqual(store.inbox(board, 'web-1').map((shout) => shout.shout_text), ['web: rebase']);
});

test('every move lands in the event log; stats count items and verdicts [R1, R2]', () => {
  const id = submitted();
  verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'red' });
  const kinds = store.events(board, { itemId: id }).map((event) => `${event.event_by}:${event.event_kind}`);
  assert.deepEqual(kinds, ['coordinator:add', 'web-1:claim', 'web-1:submit', 'web-2:reject']);
  const stats = store.stats(board);
  assert.equal(stats.items.open, 1);
  assert.equal(stats.rejected, 1);
});
