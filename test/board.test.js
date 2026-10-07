/**
 * The board's rules on an in-memory board with a hand-turned clock (B4–B7, V1, V2, V5, V6, V8, R1,
 * R2). The git-facing rules (V3, V4, V7) run against real repos in e2e.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('one live top-level claim per agent; child items are free; lanes hold, the coordinator\'s too [B5, B12]', () => {
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'One' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Two' });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'One, part', parentId: first });
  const api = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Endpoint' });
  claimAs(first, 'web-1', 'web');
  assert.throws(() => claimAs(second, 'web-1', 'web'), /ONE_CLAIM/);
  claimAs(child, 'web-1', 'web');
  assert.throws(() => claimAs(api, 'web-1', 'web'), /WRONG_LANE/);
  assert.throws(() => claimAs(api, 'coordinator', 'coordinator'), /WRONG_LANE.*built from that lane's worktree, never the main checkout/);
  const notes = store.addItem(board, { by: 'coordinator', lane: 'coordinator', title: 'Release notes' });
  assert.equal(claimAs(notes, 'coordinator', 'coordinator').renewed, false);
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
  store.verify(board, id, { head: SHA_A, digest: 'digest:Page', policy: 'any', note: 'broke the fix; its test failed; restored it', ...fields });

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

test('a verdict against a moved criterion is refused [V2, V3]', () => {
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
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: '' }), /NOTE_REQUIRED/);
  assert.throws(() => verdict(id, { agentId: 'web-2', decision: 'ACCEPT', note: ' ' }), /PROOF_REQUIRED/);
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

test('an item can wait on others: claiming it is refused until they are verified', () => {
  const contract = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Store module' });
  const user = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Uses the store', after: [contract] });
  assert.throws(() => claimAs(user, 'api-1', 'api'), /BLOCKED.*#2 waits on #1 \(open, web lane\)/);
  claimAs(contract, 'web-1', 'web');
  store.submit(board, contract, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.throws(() => claimAs(user, 'api-1', 'api'), /BLOCKED.*\(submitted/);
  store.verify(board, contract, { agentId: 'web-2', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Store module', policy: 'any', note: 'reverted the module; its test failed' });
  assert.equal(claimAs(user, 'api-1', 'api').renewed, false);
  const dropped = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Dropped' });
  store.withdraw(board, dropped, { agentId: 'coordinator', reason: 'not needed' });
  assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Late', after: [dropped] }), /WITHDRAWN/);
});

test('a board made by an older version is migrated on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-migrate-'));
  try {
    const file = join(dir, 'board.sqlite');
    const old = store.openBoard(file, clock);
    for (const column of ['item_after', 'item_brief', 'item_route', 'item_check', 'item_claim_head', 'item_files']) old.db.exec(`ALTER TABLE item DROP COLUMN ${column}`);
    old.db.exec('ALTER TABLE agent DROP COLUMN agent_route');
    old.db.exec('DROP TABLE hold');
    store.closeBoard(old);
    const reopened = store.openBoard(file, clock);
    const columns = (table) => reopened.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const [items, agents, holds] = [columns('item'), columns('agent'), columns('hold')];
    store.closeBoard(reopened);
    for (const column of ['item_after', 'item_brief', 'item_route', 'item_check', 'item_claim_head', 'item_files']) assert.ok(items.includes(column), column);
    assert.ok(holds.includes('hold_reason'));
    assert.ok(agents.includes('agent_route'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('next finds the oldest free item in your lane, or says what everything waits on [N2, N13]', () => {
  const contract = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Contract' });
  const later = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Uses it', after: [contract] });
  assert.deepEqual(store.nextFor(board, { agentId: 'api-1', lane: 'api' }), { item: null, reasons: [`#${later} waits on #${contract} (open, web lane)`] });
  assert.deepEqual(store.nextFor(board, { agentId: 'coordinator', lane: 'coordinator' }).reasons, ["no open items in the coordinator lane; lane items are built from each lane's own worktree"]);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, contract);
  claimAs(contract, 'web-1', 'web');
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_status, 'claimed');
  store.submit(board, contract, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web', verify: true }).item, null);
  assert.equal(store.nextFor(board, { agentId: 'web-2', lane: 'web', verify: true }).item.item_id, contract);
  assert.deepEqual(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).reasons, [
    `no open items in the web lane; #${contract} still awaits a verdict, and a rejected item comes back to this lane. A lane is done when its items are verified`,
  ]);
  store.verify(board, contract, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the contract test fails', head: SHA_A, digest: 'digest:Contract', policy: 'any' });
  assert.deepEqual(store.nextFor(board, { agentId: 'api-1', lane: 'api' }).reasons, [`#${later} waits on #${contract} (open, rejected, web lane)`]);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, contract);
});

test('an item carries a brief; editing it changes how to build, never what [B10]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Help text', brief: '  Copy how add prints.  ' });
  assert.equal(store.getItem(board, id).item_brief, 'Copy how add prints.');
  claimAs(id, 'web-1', 'web');
  const digest = store.getItem(board, id).item_frozen_digest;
  store.editItem(board, id, { agentId: 'coordinator', brief: 'Copy how add prints; test it like add.' });
  assert.equal(store.getItem(board, id).item_brief, 'Copy how add prints; test it like add.');
  assert.equal(store.getItem(board, id).item_frozen_digest, digest);
  assert.throws(() => store.editItem(board, id, { agentId: 'api-1', brief: 'mine now' }), /NOT_YOURS.*coordinator/);
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator' }), /USAGE/);
  assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Huge', brief: 'x'.repeat(8001) }), /BRIEF_TOO_LONG/);
  assert.deepEqual(JSON.parse(store.events(board, { itemId: id }).find((event) => event.event_kind === 'edit').event_detail), { brief: '38 characters' });
  store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  store.verify(board, id, { agentId: 'web-2', decision: 'ACCEPT', head: SHA_A, digest, policy: 'any', note: 'removed the help case; its test failed' });
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', brief: 'late' }), /CLOSED/);
});

const BRIEF = 'Files:\n- web/a.js\nChange:\n- rename x to y\nTest:\n- test/a.test.js asserts y is exported\nOut of scope: anything else';

/**
 * Add a web item routed below strong, complete unless a field is overridden.
 */
const routed = (title, route, extra = {}) =>
  store.addItem(board, { by: 'coordinator', lane: 'web', title, route, brief: BRIEF, criterion: 'y is exported', check: 'node --test', ...extra });

test('routes are tiers: an agent claims and verifies its tier and below, its own first [B13]', () => {
  store.register(board, { lane: 'web', path: '/repo-web-3', route: 'light' });
  store.register(board, { lane: 'web', path: '/repo-web-4', route: 'mid' });
  assert.throws(() => store.register(board, { lane: 'web', path: '/repo-web-3' }), /ALREADY_JOINED.*routed light/);
  assert.throws(() => store.register(board, { lane: 'web', path: '/repo-web-9', route: 'cheap' }), /BAD_ROUTE/);
  const light = routed('Rename', 'light');
  const mid = routed('Small feature', 'mid');
  const strong = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Design the cache' });
  assert.throws(() => claimAs(strong, 'web-3', 'web'), /ROUTE.*needs a strong model; you joined on the light route/);
  assert.throws(() => claimAs(mid, 'web-3', 'web'), /ROUTE.*needs a mid model/);
  assert.equal(store.nextFor(board, { agentId: 'web-3', lane: 'web' }).item.item_id, light);
  assert.equal(store.nextFor(board, { agentId: 'web-4', lane: 'web' }).item.item_id, mid);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, strong);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web', runnable: true }).item.item_id, mid);
  assert.equal(store.nextFor(board, { agentId: 'web-4', lane: 'web', routes: ['light'] }).item.item_id, light);
  claimAs(strong, 'web-1', 'web');
  assert.throws(() => store.editItem(board, strong, { agentId: 'coordinator', route: 'mid' }), /HELD.*only while it is open/);
  store.submit(board, strong, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.equal(store.nextFor(board, { agentId: 'web-4', lane: 'web', verify: true }).item, null);
  const verdict = { agentId: 'web-4', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Design the cache', policy: 'any', note: 'tried it' };
  assert.throws(() => store.verify(board, strong, verdict), /ROUTE.*needs a strong verifier; you joined on the mid route/);
  store.verify(board, strong, { ...verdict, agentId: 'web-2' });
  assert.equal(claimAs(light, 'web-4', 'web').renewed, false);
});

test('below strong, an item is buildable cold: files, a test, a criterion and a check [B14]', () => {
  assert.throws(() => routed('No files', 'light', { brief: 'Change: x' }), /NO_BRIEF.*Files: section.*Test: section/);
  assert.throws(() => routed('No check', 'mid', { check: '' }), /NO_BRIEF.*--check, the command that proves it/);
  assert.throws(() => routed('No criterion', 'light', { criterion: ' ' }), /NO_BRIEF.*--criterion/);
  const id = routed('Rename', 'light');
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', brief: '' }), /NO_BRIEF/);
  assert.equal(store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Loose', route: 'strong' }) > id, true);
});

test('changing a criterion or a check drops the frozen bar, in the open; the next claim freezes anew [B14]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', check: 'npm test' }), /HELD/);
  store.release(board, id, 'web-1');
  store.editItem(board, id, { agentId: 'coordinator', check: 'npm test', criterion: 'renders' });
  assert.equal(store.getItem(board, id).item_frozen_digest, null);
  const edit = store.events(board, { itemId: id }).find((event) => event.event_kind === 'edit');
  assert.deepEqual(JSON.parse(edit.event_detail), { criterion: 'renders', check: 'npm test', unfrozen: 'digest:Page' });
  assert.equal(claimAs(id, 'web-1', 'web').digest, 'digest:Page');
});

test('escalate frees an item one tier up, with what was tried attached [B15]', () => {
  store.register(board, { lane: 'web', path: '/repo-web-3', route: 'light' });
  const id = routed('Rename', 'light');
  claimAs(id, 'web-3', 'web');
  assert.throws(() => store.escalate(board, id, { agentId: 'web-1', note: 'x' }), /NOT_YOURS/);
  assert.throws(() => store.escalate(board, id, { agentId: 'web-3', note: ' ' }), /NOTE_REQUIRED/);
  store.recordAttempt(board, id, { agentId: 'web-3', n: 1, seconds: 40, result: 'red' });
  assert.deepEqual(store.escalate(board, id, { agentId: 'web-3', note: 'check failed twice', attempt: 'refs/pullboard/attempts/1/abc' }), { from: 'light', to: 'mid' });
  const item = store.getItem(board, id);
  assert.deepEqual([item.item_status, item.item_route, item.item_owner], ['open', 'mid', null]);
  assert.throws(() => claimAs(id, 'web-3', 'web'), /ROUTE/);
  assert.deepEqual(store.escalate(board, id, { agentId: 'coordinator', note: 'needs judgment' }), { from: 'mid', to: 'strong' });
  assert.deepEqual(store.escalate(board, id, { agentId: 'coordinator', note: 'still stuck' }), { from: 'strong', to: 'strong' });
  const moves = store.events(board, { itemId: id }).map((event) => event.event_kind).filter((kind) => ['attempt', 'escalate'].includes(kind));
  assert.deepEqual(moves, ['attempt', 'escalate', 'escalate', 'escalate']);
});

test('a fresh claim records where the work started; submit records what it changed, reworks included [N21]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const claimAt = (head) => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, head });
  claimAt(SHA_A);
  claimAt(SHA_B);
  assert.equal(store.getItem(board, id).item_claim_head, SHA_A, 'a renewal keeps the first head');
  store.submit(board, id, { agentId: 'web-1', commit: SHA_B, tree: 't', files: ['web/page.js', 'web/page.test.js'] });
  verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'an empty page throws' });
  claimAt(SHA_B);
  assert.equal(store.getItem(board, id).item_claim_head, SHA_B, 'the rework starts from the rejected head');
  store.submit(board, id, { agentId: 'web-1', commit: 'c'.repeat(40), tree: 't2', files: ['web/page.js', 'web/empty.js'] });
  assert.deepEqual(store.itemFiles(store.getItem(board, id)), ['web/page.js', 'web/page.test.js', 'web/empty.js']);
});

test('related items: verified work that touched the same files, the most shared first [N21]', () => {
  const build = (title, files) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    claimAs(id, 'web-1', 'web');
    store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't', files });
    return id;
  };
  const header = build('Header', ['web/layout.js', 'web/header.js']);
  const footer = build('Footer', ['web/layout.js']);
  const api = build('Route', ['api/route.js']);
  build('Pending', ['web/layout.js', 'web/header.js']);
  for (const [id, title] of [[header, 'Header'], [footer, 'Footer'], [api, 'Route']]) verdict(id, { agentId: 'web-2', decision: 'ACCEPT', digest: `digest:${title}` });
  const nav = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Nav', brief: 'Files: web/header.js, web/layout.js' });
  assert.deepEqual(
    store.relatedItems(board, store.getItem(board, nav)).map(({ item, shared }) => [item.item_id, shared]),
    [[header, ['web/layout.js', 'web/header.js']], [footer, ['web/layout.js']]],
  );
  const loose = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Copy' });
  assert.deepEqual(store.relatedItems(board, store.getItem(board, loose)), []);
});

test('within a tier, next takes the item nearest your recent work and names the shared files [N20]', () => {
  const footer = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Footer', brief: 'Files: web/footer.js' });
  const nav = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Nav', brief: 'Files: web/header.js, web/nav.js' });
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, footer, 'with nothing warm, the oldest');
  const warm = store.nextFor(board, { agentId: 'web-1', lane: 'web', warm: ['web/header.js', 'web/layout.js'] });
  assert.equal(warm.item.item_id, nav);
  assert.deepEqual(warm.shared, ['web/header.js']);
  const mid = routed('Rename', 'mid', { brief: BRIEF.replace('web/a.js', 'web/header.js') });
  const midAgent = store.register(board, { lane: 'web', path: '/repo-web-3', route: 'mid' });
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web', warm: ['web/header.js'] }).item.item_id, nav, 'a strong agent takes strong work first');
  assert.equal(store.nextFor(board, { agentId: midAgent, lane: 'web', warm: ['web/footer.js'] }).item.item_id, mid, 'a mid agent never gets strong work');
});

test('a held lane takes no new claims and says who held it and why; claimed work goes on [N22]', () => {
  const page = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const nav = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Nav' });
  claimAs(page, 'web-1', 'web');
  assert.throws(() => store.holdLane(board, 'web', { agentId: 'web-1', reason: 'mine' }), /COORDINATOR_ONLY/);
  assert.throws(() => store.holdLane(board, 'web', { agentId: 'coordinator', reason: ' ' }), /USAGE/);
  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'the spec rows are changing' });
  assert.deepEqual(store.nextFor(board, { agentId: 'web-2', lane: 'web' }), { item: null, reasons: ['coordinator holds the web lane: the spec rows are changing'] });
  assert.throws(() => claimAs(nav, 'web-2', 'web'), /LANE_HELD.*the spec rows are changing/);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, page, 'claimed work goes on');
  assert.equal(claimAs(page, 'web-1', 'web').renewed, true);
  assert.equal(store.nextFor(board, { agentId: 'api-1', lane: 'api' }).reasons[0], 'no open items in the api lane');
  store.releaseLane(board, 'web', { agentId: 'coordinator' });
  assert.equal(store.nextFor(board, { agentId: 'web-2', lane: 'web' }).item.item_id, nav);
  assert.throws(() => store.releaseLane(board, 'web', { agentId: 'coordinator' }), /NOT_HELD/);
  assert.deepEqual(store.events(board).map((event) => event.event_kind).filter((kind) => kind.endsWith('hold')), ['hold', 'unhold']);
});

test('peeking shows the newest unread shouts and leaves them unread [N19]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  for (const text of ['one', 'two', 'three']) store.shout(board, { from: 'coordinator', to: 'web-1', text, lanes });
  assert.deepEqual(store.peekShouts(board, 'web-1').map((shout) => shout.shout_text), ['two', 'three']);
  assert.equal(store.unreadCount(board, 'web-1'), 3);
  store.inbox(board, 'web-1');
  assert.deepEqual(store.peekShouts(board, 'web-1'), []);
});

test('with only work above its tier open in its lane, next names it and the reroute [B16]', () => {
  const light = store.register(board, { lane: 'web', path: '/repo-web-3', route: 'light' });
  const strong = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Design the cache' });
  assert.deepEqual(store.nextFor(board, { agentId: light, lane: 'web' }).reasons, [
    'no open light items in the web lane',
    `#${strong} (strong) is open in the web lane, above your light route: a strong agent takes it, or, if light can build it, the coordinator reroutes it: pullboard edit ${strong} --route light`,
  ]);
  assert.deepEqual(store.nextFor(board, { agentId: 'api-1', lane: 'api' }).reasons, ['no open items in the api lane']);
  const contract = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Contract' });
  const blocked = routed('Wire it', 'light', { after: [contract] });
  assert.deepEqual(store.nextFor(board, { agentId: light, lane: 'web' }).reasons, [
    `#${blocked} waits on #${contract} (open, api lane)`,
    `#${strong} (strong) is open in the web lane, above your light route: a strong agent takes it, or, if light can build it, the coordinator reroutes it: pullboard edit ${strong} --route light`,
  ], 'a blocked item of your own tier does not hide the work above it');
});

test('a builder reworks its own rejected item beside its one claim; nothing else doubles up [B5]', () => {
  const rejected = (title) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    claimAs(id, 'web-1', 'web');
    store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
    verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'fails', digest: `digest:${title}` });
    return id;
  };
  const page = rejected('Page');
  const footer = rejected('Footer');
  const aside = rejected('Aside');
  const header = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Header' });
  const nav = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Nav' });
  claimAs(page, 'web-1', 'web');
  assert.equal(claimAs(header, 'web-1', 'web').renewed, false, 'holding only a rework, one new claim is still free');
  assert.equal(claimAs(footer, 'web-1', 'web').renewed, false, 'a second rework of its own, beside its claim');
  assert.throws(() => claimAs(nav, 'web-1', 'web'), new RegExp(`ONE_CLAIM.*you already hold #${header}`));
  store.submit(board, page, { agentId: 'web-1', commit: SHA_B, tree: 't2' });
  assert.equal(store.getItem(board, page).item_status, 'submitted');
  claimAs(nav, 'web-2', 'web');
  assert.throws(() => claimAs(aside, 'web-2', 'web'), /ONE_CLAIM/, "another agent's rejected item is no rework of web-2's");
});
