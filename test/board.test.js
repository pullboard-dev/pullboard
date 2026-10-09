/**
 * The board's rules on an in-memory board with a hand-turned clock (B4–B7, V1, V2, V5, V6, V8, R1,
 * R2). The git-facing rules (V3, V4, V7) run against real repos in e2e.test.js.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard } from '../src/exchange.js';
import { main } from '../src/cli.js';
import { briefFiles } from '../src/brief.js';
import { JSON_SHAPES } from '../src/json.js';

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

/**
 * Run one CLI command with captured text and JSON output streams.
 *
 * @param {string} cwd
 * @param {string[]} argv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runMain(cwd, argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

/**
 * Freeze the real spec row shape that `show` renders for the family integration fixture.
 *
 * @returns {{ text: string, digest: string }}
 */
function familyFreeze() {
  return {
    text: JSON.stringify({ rows: [{ id: 'G1', text: 'Families are recorded.', gate: 'true' }] }),
    digest: 'digest:family',
  };
}

/**
 * Check every required top-level JSON result field against the shared CLI catalog.
 *
 * @param {any} result
 * @param {string} command
 */
function assertJsonShape(result, command) {
  for (const [key, type] of Object.entries(JSON_SHAPES.commands[command].required)) {
    const correct = type === 'array' ? Array.isArray(result[key]) : typeof result[key] === type;
    assert.equal(correct, true, `${command} JSON field ${key}`);
  }
}

beforeEach(() => {
  let at = Date.parse('2026-10-04T12:00:00Z');
  clock = { now: () => new Date(at), advance: (ms) => { at += ms; } };
  board = store.openBoard(':memory:', clock);
  store.register(board, { lane: 'coordinator', path: '/repo' });
  store.register(board, { lane: 'web', path: '/repo-web-1' });
  store.register(board, { lane: 'web', path: '/repo-web-2' });
  store.register(board, { lane: 'api', path: '/repo-api-1' });
});

test('[B14] notes in parentheses are not paths, and a foreign path still refuses', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-brief-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true',
    spec: 'SPEC.md',
    lanes: {
      web: { owns: ['src/'], specs: [] },
      api: { owns: ['api/'], specs: [] },
    },
    shared: ['README.md', 'docs/'],
  }));
  const brief = 'Files:\n- src/x.js, README.md, docs/, make. folders). api/server.js.\nChange: add a page\nTest: check the page';
  assert.deepEqual(briefFiles(brief), ['src/x.js', 'README.md', 'docs/', 'api/server.js']);
  const noted = 'Files:\n- src/a.js (only where a checked claim changed in 0.8.1 (see api/v1.js)) .8.1 1..2 0.8.1\n- src/b.js (main.moved and skills/ stay as they are)';
  assert.deepEqual(briefFiles(noted), ['src/a.js', 'src/b.js']);
  const unclosed = 'Files:\n- src/a.js (old note api/x.js';

  let stdout = '';
  let stderr = '';
  const code = await main([
    'add', 'web', 'Page', '--route', 'light', '--criterion', 'the page renders', '--check', 'true', '--brief', brief,
  ], {
    cwd: repo,
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  assert.equal(code, 1, stdout);
  assert.match(stderr, /BRIEF_LANE.*api\/server\.js \(api's\)/);
  assert.doesNotMatch(stderr, /make\.|folders\)/);

  let unclosedStderr = '';
  const unclosedCode = await main([
    'add', 'web', 'Page', '--route', 'light', '--criterion', 'the page renders', '--check', 'true', '--brief', `${unclosed}\nChange: update the page\nTest: check the page`,
  ], {
    cwd: repo,
    stdout: { isTTY: false, write: () => {} },
    stderr: { write: (text) => { unclosedStderr += text; } },
  });
  assert.equal(unclosedCode, 1);
  assert.match(unclosedStderr, /BRIEF_LANE.*api\/x\.js/u);
  assert.deepEqual(briefFiles(unclosed), ['src/a.js', 'api/x.js']);
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

test('[N26,A2] milestones stay ordered and only the coordinator can edit them', () => {
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Build' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Publish' });
  store.addMilestone(board, { agentId: 'coordinator', name: 'Release', note: 'Ship it', items: [first] });
  store.addMilestone(board, { agentId: 'coordinator', name: 'Aftercare', items: [second] });
  store.editMilestoneItems(board, 'Release', { agentId: 'coordinator', add: [second] });
  assert.deepEqual(store.milestones(board).find(({ name }) => name === 'Release').items, [first, second], 'adding preserves item order');
  store.editMilestoneItems(board, 'Release', { agentId: 'coordinator', remove: [second] });
  assert.deepEqual(store.milestones(board).find(({ name }) => name === 'Release').items, [first], 'removing preserves the remaining order');
  store.moveMilestone(board, 'Aftercare', { agentId: 'coordinator', before: 'Release' });
  store.editMilestone(board, 'Aftercare', { agentId: 'coordinator', newName: 'Maintenance', note: 'Keep watching' });
  assert.deepEqual(store.milestones(board).map(({ name }) => name), ['Maintenance', 'Release']);
  assert.throws(() => store.addMilestone(board, { agentId: 'web-1', name: 'Forbidden' }), /COORDINATOR_ONLY/);

  claimAs(second, 'api-1', 'api');
  const current = store.roadmap(board);
  assert.deepEqual(current.map(({ name, done, total }) => ({ name, done, total })), [
    { name: 'Maintenance', done: 0, total: 1 },
    { name: 'Release', done: 0, total: 1 },
  ]);
  assert.equal(current[0].items[0].status, 'claimed', "roadmap reads the item's current state");
  store.submit(board, second, { agentId: 'api-1', commit: SHA_A, tree: 'tree-a' });
  store.verify(board, second, {
    agentId: 'web-2', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked the expected result',
    head: SHA_A, digest: 'digest:Publish', policy: 'any',
  });
  assert.equal(store.roadmap(board)[0].done, 1, 'done counts follow verified item state');
  store.removeMilestone(board, 'Maintenance', { agentId: 'coordinator' });
  assert.deepEqual(store.milestones(board).map(({ name }) => name), ['Release']);
  assert.equal(store.getItem(board, second).item_status, 'verified', 'removing a milestone leaves its item untouched');
});

test('[H3,H16] captured milestone operations replay identically on SQLite replicas', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-milestone-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = { now: () => new Date('2026-10-08T00:00:00.000Z') };
  const left = store.openBoard(join(directory, 'left.sqlite'), clock);
  const right = store.openBoard(join(directory, 'right.sqlite'), clock);
  t.after(() => { store.closeBoard(left); store.closeBoard(right); });
  for (const replica of [left, right]) {
    store.register(replica, { lane: 'coordinator', path: '/repo' });
    store.register(replica, { lane: 'app', path: '/repo-app' });
    store.addItem(replica, { by: 'coordinator', lane: 'app', title: 'Build' });
    store.addItem(replica, { by: 'coordinator', lane: 'app', title: 'Publish' });
    replica.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run('a'.repeat(32), 'board_id');
  }
  const operations = [
    ['addMilestone', [{ agentId: 'coordinator', name: 'Release', note: 'Ship', items: [1] }]],
    ['addMilestone', [{ agentId: 'coordinator', name: 'Aftercare', items: [2] }]],
    ['editMilestoneItems', ['Aftercare', { agentId: 'coordinator', add: [1] }]],
    ['moveMilestone', ['Aftercare', { agentId: 'coordinator', before: 'Release' }]],
    ['editMilestone', ['Release', { agentId: 'coordinator', newName: 'Launch', note: 'Ready' }]],
    ['claim', [2, { agentId: 'app-1', lane: 'app', leaseMs: HOUR, freeze: () => ({ text: 'Publish', digest: 'digest:Publish' }) }]],
    ['removeMilestone', ['Launch', { agentId: 'coordinator' }]],
  ];
  left.clock = { now: () => new Date('2026-10-08T01:00:00.000Z') };
  right.clock = { now: () => new Date('2026-10-08T02:00:00.000Z') };
  operations.forEach(([operation, args], index) => {
    const move = prepareEngineMove(left, operation, args, { id: `milestone-${index}` });
    const options = { sequence: index + 1, at: `2026-10-08T00:00:0${index}.000Z` };
    assert.deepEqual(applyEngineMove(left, move, options), applyEngineMove(right, move, options));
  });
  const readClock = { now: () => new Date('2026-10-08T00:10:00.000Z') };
  left.clock = readClock;
  right.clock = readClock;
  assert.deepEqual(store.milestones(left), store.milestones(right));
  assert.deepEqual(store.events(left), store.events(right));
  assert.deepEqual(store.roadmap(left), store.roadmap(right));
  assert.deepEqual(exportBoard(left), exportBoard(right), 'native exports include matching metadata and replay receipts');
  assert.equal(store.roadmap(left)[0].items[0].status, 'claimed');
});

test('a claim is a lease: renewable by its holder, free again once it lapses [B4]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  assert.throws(() => claimAs(id, 'web-2', 'web'), /HELD/);
  clock.advance(HOUR);
  assert.equal(claimAs(id, 'web-1', 'web').renewed, true);
  clock.advance(HOUR + 1);
  assert.throws(() => claimAs(id, 'web-2', 'web'), /HELD/, 'two hours after the first claim, the renewal still holds it');
  clock.advance(HOUR);
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

/** A verifier can release its live review reservation for another verifier [V15]. */
test('a verifier releases its reserved review; another verifier can take it, and claims still release [V15]', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-review-release-'));
  const durable = store.openBoard(join(directory, 'board.sqlite'), clock);
  try {
    store.register(durable, { lane: 'coordinator', path: '/repo' });
    const builder = store.register(durable, { lane: 'web', path: '/repo-web-1' });
    const reviewer = store.register(durable, { lane: 'web', path: '/repo-web-2' });
    const second = store.register(durable, { lane: 'web', path: '/repo-web-3' });
    const third = store.register(durable, { lane: 'web', path: '/repo-web-4' });
    const id = store.addItem(durable, { by: 'coordinator', lane: 'web', title: 'Page' });
    store.claim(durable, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    store.submit(durable, id, { agentId: builder, commit: SHA_A, tree: 'tree-a' });
    store.reserveReview(durable, id, { agentId: reviewer, leaseMs: HOUR, policy: 'any' });

    assert.equal(store.release(durable, id, reviewer), true);
    assert.deepEqual(
      [store.getItem(durable, id).item_review_by, store.getItem(durable, id).item_review_until],
      [null, null],
    );
    assert.equal(store.events(durable, { itemId: id }).at(-1).event_kind, 'release');
    assert.equal(store.reserveReview(durable, id, { agentId: second, leaseMs: HOUR, policy: 'any' }).item_review_by, second);
    assert.throws(() => store.release(durable, id, third), /NOT_YOURS/);

    const claimed = store.addItem(durable, { by: 'coordinator', lane: 'web', title: 'Another page' });
    store.claim(durable, claimed, { agentId: reviewer, lane: 'web', leaseMs: HOUR, freeze });
    assert.equal(store.release(durable, claimed, reviewer), false);
    assert.equal(store.getItem(durable, claimed).item_status, 'open');
  } finally {
    store.closeBoard(durable);
    rmSync(directory, { recursive: true, force: true });
  }
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

test('a shout can ask for a decision; it stays open until someone answers it [B21]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const ask = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'ship the page today or tomorrow?', lanes, decision: true });
  const note = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'fyi: the gate is slow', lanes });
  assert.deepEqual(store.openDecisions(board, 'coordinator').map((shout) => shout.shout_id), [ask]);
  assert.throws(() => store.shout(board, { from: 'coordinator', to: 'web-1', text: 'ok', lanes, answers: note }), /NOT_A_DECISION/);
  assert.throws(() => store.shout(board, { from: 'coordinator', to: 'web-1', text: 'ok', lanes, answers: 999 }), /NO_SHOUT/);
  assert.deepEqual(store.openDecisions(board, 'coordinator').map((shout) => shout.shout_id), [ask], 'a refused answer leaves it open');
  const answer = store.shout(board, { from: 'coordinator', to: 'web-1', text: 'today', lanes, answers: ask });
  assert.deepEqual(store.openDecisions(board, 'coordinator'), []);
  assert.equal(store.getShout(board, answer).shout_answers, ask);
  assert.equal(store.getShout(board, ask).shout_text, 'ship the page today or tomorrow?', 'an answer is a new shout; the ask is never edited');
});

test('an agent answers its lane decision and the reply reaches the asker [B21,B27]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const ask = store.shout(board, { from: 'web-1', to: 'api', text: 'Should the endpoint retry?', lanes, decision: true });
  const answer = store.answerDecision(board, ask, { agentId: 'api-1', text: 'Retry once.', lanes });
  const reply = store.getShout(board, answer);
  assert.equal(reply.shout_from, 'api-1', 'the responding agent is identified');
  assert.equal(reply.shout_to, 'web-1', 'the answer goes to the original asker');
  assert.equal(reply.shout_answers, ask, 'the reply closes the lane decision');
  assert.equal(store.inbox(board, 'web-1').find(({ shout_id }) => shout_id === answer).shout_text, 'Retry once.');
  assert.deepEqual(store.openDecisions(board, 'api'), []);
});

test('an agent cannot answer another lane decision [B21,B27]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const ask = store.shout(board, { from: 'web-1', to: 'api', text: 'Should the endpoint retry?', lanes, decision: true });
  assert.throws(
    () => store.answerDecision(board, ask, { agentId: 'web-2', text: 'Retry once.', lanes }),
    /NOT_YOUR_DECISION.*api.*web/u,
  );
  assert.deepEqual(store.openDecisions(board, 'api').map(({ shout_id }) => shout_id), [ask]);
});

test('the decisions store query accepts multiple recipients once in shout order [B21,B27]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const laneAsk = store.shout(board, { from: 'web-1', to: 'api', text: 'lane?', lanes, decision: true });
  const directAsk = store.shout(board, { from: 'web-1', to: 'api-1', text: 'direct?', lanes, decision: true });
  const otherLaneAsk = store.shout(board, { from: 'web-1', to: 'web', text: 'other?', lanes, decision: true });
  assert.deepEqual(store.openDecisions(board, ['api-1', 'api', 'api']).map(({ shout_id }) => shout_id), [laneAsk, directAsk]);
  store.answerDecision(board, laneAsk, { agentId: 'api-1', text: 'yes', lanes });
  assert.deepEqual(store.openDecisions(board, ['api-1', 'api']).map(({ shout_id }) => shout_id), [directAsk]);
  assert.deepEqual(store.openDecisions(board, []), []);
  assert.deepEqual(store.openDecisions(board, 'web').map(({ shout_id }) => shout_id), [otherLaneAsk]);
});

test('decisions climb to the person and answers return to the first asker [B25, B26, B27]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const original = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Ship today?', lanes, decision: true });
  assert.throws(() => store.shout(board, { from: 'web-1', to: 'person', text: 'Ship today?', lanes, decision: true }), /B26_PERSON_DECISION.*ask your coordinator/);
  const passed = store.passDecision(board, original, { agentId: 'coordinator', note: 'the final CSS screenshot is ready', lanes });
  const escalated = store.getShout(board, passed);
  assert.equal(escalated.shout_to, 'person');
  assert.equal(escalated.shout_answers, original);
  assert.match(escalated.shout_text, /web-1: Ship today\?/);
  assert.match(escalated.shout_text, /final CSS screenshot is ready/);
  assert.deepEqual(store.openDecisions(board, 'person').map((row) => row.shout_id), [passed]);
  assert.deepEqual(store.openDecisions(board, 'coordinator'), []);
  assert.throws(() => store.answerDecision(board, passed, { agentId: 'web-1', text: 'No', lanes }), /NOT_YOUR_DECISION/);
  assert.deepEqual(store.openDecisions(board, 'person').map((row) => row.shout_id), [passed]);
  assert.throws(() => store.answerDecision(board, passed, { agentId: 'coordinator', text: 'Yes, ship today.', lanes }), /B26_PERSON_ANSWER.*--as person/);
  const answer = store.answerDecision(board, passed, { agentId: 'coordinator', text: 'Yes, ship today.', lanes, asPerson: true });
  assert.equal(store.getShout(board, answer).shout_from, 'person');
  assert.deepEqual(store.openDecisions(board, 'person'), []);
  assert.deepEqual(store.openDecisions(board, 'coordinator'), []);
  assert.throws(() => store.passDecision(board, original, { agentId: 'coordinator', note: 'retry', lanes }), /ALREADY_ANSWERED/);
  assert.throws(() => store.answerDecision(board, passed, { agentId: 'coordinator', text: 'Again', lanes }), /ALREADY_ANSWERED/);
  const delivered = store.inbox(board, 'web-1');
  assert.equal(delivered[0].shout_text, `Person answered #${passed}: Yes, ship today.`);
  assert.equal(delivered[0].shout_answers, original, 'the notice closes the first asker’s decision');
});

test('only the coordinator can pass an open coordinator decision [B27]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const ask = store.shout(board, { from: 'web-1', to: 'coordinator', text: 'Ship?', lanes, decision: true });
  assert.throws(() => store.passDecision(board, ask, { agentId: 'web-1', note: 'please', lanes }), /COORDINATOR_ONLY/);
  assert.throws(() => store.passDecision(board, ask, { agentId: 'coordinator', note: '', lanes }), /EMPTY_NOTE/);
  assert.equal(store.openDecisions(board, 'coordinator')[0].shout_id, ask);
});

test('a shout can carry typed evidence: attempt or receipt, outcome, item and commit [B22]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  const id = submitted();
  const evidence = { kind: 'receipt', outcome: 'measured', item: id, commit: SHA_A };
  const stored = store.getShout(board, store.shout(board, { from: 'web-2', to: 'coordinator', text: 'FINISH the page holds', lanes, evidence }));
  assert.deepEqual([stored.shout_evidence_kind, stored.shout_evidence_outcome, stored.shout_evidence_item, stored.shout_evidence_commit], ['receipt', 'measured', id, SHA_A]);
  const refused = (fields, field) =>
    assert.throws(() => store.shout(board, { from: 'web-2', to: 'coordinator', text: 'x', lanes, evidence: { ...evidence, ...fields } }), new RegExp(`BAD_EVIDENCE.*${field}`));
  refused({ kind: 'hunch' }, 'attempt or receipt');
  refused({ outcome: '  ' }, 'outcome');
  refused({ item: 999 }, 'an item on the board');
  refused({ commit: 'abc' }, 'full SHA');
  assert.equal(store.getShout(board, store.shout(board, { from: 'web-2', to: 'coordinator', text: 'no evidence', lanes })).shout_evidence_kind, null);
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

test('an item can wait on others: claiming it is refused until they are verified [B8]', () => {
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

test('a board made by an older version is migrated on open [O3]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-migrate-'));
  try {
    const file = join(dir, 'board.sqlite');
    const old = store.openBoard(file, clock);
    for (const column of ['item_after', 'item_brief', 'item_route', 'item_check', 'item_claim_head', 'item_files', 'item_builder_family']) old.db.exec(`ALTER TABLE item DROP COLUMN ${column}`);
    for (const column of ['agent_route', 'agent_family']) old.db.exec(`ALTER TABLE agent DROP COLUMN ${column}`);
    old.db.exec('ALTER TABLE verdict DROP COLUMN verdict_verifier_family');
    old.db.exec('DROP TABLE hold');
    store.closeBoard(old);
    const reopened = store.openBoard(file, clock);
    const columns = (table) => reopened.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const [items, agents, verdicts, holds] = [columns('item'), columns('agent'), columns('verdict'), columns('hold')];
    store.closeBoard(reopened);
    for (const column of ['item_after', 'item_brief', 'item_route', 'item_check', 'item_claim_head', 'item_files']) assert.ok(items.includes(column), column);
    assert.ok(holds.includes('hold_reason'));
    assert.ok(agents.includes('agent_route'));
    assert.ok(agents.includes('agent_family'));
    assert.ok(items.includes('item_builder_family'));
    assert.ok(verdicts.includes('verdict_verifier_family'));
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

test('edit after an expired claim reopens it and names its holder [B13]', () => {
  const edits = [
    { title: 'Criterion', change: { criterion: 'the new criterion' } },
    { title: 'Check', change: { check: 'node --test' } },
    { title: 'Route', change: { route: 'mid' } },
  ];
  for (const { title, change } of edits) {
    const id = store.addItem(board, {
      by: 'coordinator', lane: 'web', title, route: 'light', brief: BRIEF,
      criterion: 'the old criterion', check: 'true',
    });
    claimAs(id, 'web-1', 'web');
    clock.advance(2 * HOUR + 1);
    assert.doesNotThrow(
      () => store.editItem(board, id, { agentId: 'coordinator', ...change }),
      `an expired ${title.toLowerCase()} edit must reopen the item before writing its fields`,
    );
    const stored = store.itemById(board, id);
    assert.deepEqual([stored.item_status, stored.item_owner, stored.item_lease_until], ['open', null, null]);
    assert.equal(stored.item_frozen_digest, null);
    const event = store.events(board, { itemId: id }).findLast((entry) => entry.event_kind === 'edit');
    assert.equal(event.event_by, 'coordinator');
    assert.equal(JSON.parse(event.event_detail).expiredHolder, 'web-1');
    assert.equal(JSON.parse(event.event_detail).unfrozen, `digest:${title}`);
  }

  const live = store.addItem(board, {
    by: 'coordinator', lane: 'web', title: 'Live', route: 'light', brief: BRIEF,
    criterion: 'the old criterion', check: 'true',
  });
  claimAs(live, 'web-1', 'web');
  const digest = store.itemById(board, live).item_frozen_digest;
  assert.throws(() => store.editItem(board, live, { agentId: 'coordinator', criterion: 'not yet' }), /HELD/);
  assert.deepEqual(
    [store.itemById(board, live).item_status, store.itemById(board, live).item_owner, store.itemById(board, live).item_frozen_digest],
    ['claimed', 'web-1', digest],
  );
  assert.equal(store.events(board, { itemId: live }).some((entry) => entry.event_kind === 'edit'), false);
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
  const first = store.events(board, { itemId: id }).find((event) => event.event_kind === 'escalate');
  assert.deepEqual(JSON.parse(first.event_detail), { from: 'light', to: 'mid', note: 'check failed twice', attempt: 'refs/pullboard/attempts/1/abc' }, 'the failure and the pinned attempt travel with it');
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

test('[O3] declared families travel from join through submit and verdict, and absent family is allowed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-families-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(directory, 'pullboard-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
  });
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  /** Run Git with isolated identity and configuration in the fixture repository. */
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true',
    spec: 'SPEC.md',
    verify: 'any',
    lanes: { web: { owns: ['web/'], specs: [] }, review: { owns: ['review/'], specs: [] } },
    shared: [],
  }));
  writeFileSync(join(repo, 'SPEC.md'), '# Family test\n\n## G · Goals\n- G1 [approved, must] Families are recorded. | gate: true\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: initialize family test');

  const made = await runMain(repo, ['worktree', 'web', '--family', 'Family Alpha', '--json']);
  assert.equal(made.code, 0, made.stderr || made.stdout);
  const worktree = JSON.parse(made.stdout);
  assertJsonShape(worktree, 'worktree');
  const builderPath = worktree.path;
  const reviewerPath = join(directory, 'reviewer');
  git(repo, 'worktree', 'add', '-q', '-b', 'review/one', reviewerPath, 'main');
  const reviewerRoot = git(reviewerPath, 'rev-parse', '--show-toplevel');
  const joined = await runMain(reviewerRoot, ['join', 'review', '--family', 'Family Beta', '--json']);
  assert.equal(joined.code, 0, joined.stderr || joined.stdout);
  const joinResult = JSON.parse(joined.stdout);
  assertJsonShape(joinResult, 'join');
  const noFamilyPath = join(directory, 'no-family');
  git(repo, 'worktree', 'add', '-q', '-b', 'web/two', noFamilyPath, 'main');
  const noFamilyRoot = git(noFamilyPath, 'rev-parse', '--show-toplevel');
  const joinedWithout = await runMain(noFamilyRoot, ['join', 'web']);
  assert.equal(joinedWithout.code, 0, joinedWithout.stderr || joinedWithout.stdout);

  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const persistent = store.openBoard(file);
  t.after(() => store.closeBoard(persistent));
  assert.equal(store.agentAt(persistent, builderPath).agent_family, 'Family Alpha');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta');
  assert.equal(store.agentAt(persistent, noFamilyRoot).agent_family, null);
  store.register(persistent, { lane: 'coordinator', path: repo });
  assert.equal(store.agentAt(persistent, repo).agent_family, null, 'the core supplies no family for itself');
  store.register(persistent, { lane: 'coordinator', path: repo, family: 'Family Coordinator' });
  const coordinatorResume = await runMain(repo, ['resume']);
  assert.match(coordinatorResume.stdout, /resume: coordinator \(Family Coordinator\), coordinator lane/);
  const coordinatorJson = await runMain(repo, ['resume', '--json']);
  assert.equal(JSON.parse(coordinatorJson.stdout).me.family, 'Family Coordinator');

  const id = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'Family feature' });
  store.claim(persistent, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  store.submit(persistent, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
  assert.equal(store.getItem(persistent, id).item_builder_family, 'Family Alpha');
  store.verify(persistent, id, {
    agentId: 'review-1', decision: 'ACCEPT', note: 'checked the saved family fields',
    head: SHA_A, digest: 'digest:family', policy: 'any',
  });
  const [recorded] = store.verdictsFor(persistent, id);
  assert.equal(recorded.verdict_verifier_family, 'Family Beta');

  const shown = await runMain(repo, ['show', String(id), '--json']);
  assert.equal(shown.code, 0, shown.stderr || shown.stdout);
  const shownJson = JSON.parse(shown.stdout);
  assertJsonShape(shownJson, 'show');
  assert.equal(shownJson.item_builder_family, 'Family Alpha');
  assert.equal(shownJson.verdicts[0].verdict_verifier_family, 'Family Beta');
  const shownText = await runMain(repo, ['show', String(id)]);
  assert.match(shownText.stdout, /submitted by web-1 \(Family Alpha\)/);
  assert.match(shownText.stdout, /ACCEPT CRITERION_MET by review-1 \(Family Beta\)/);

  const redeclared = await runMain(reviewerRoot, ['join', 'review', '--family', 'Family Gamma', '--json']);
  assert.equal(redeclared.code, 0, redeclared.stderr || redeclared.stdout);
  assert.equal(JSON.parse(redeclared.stdout).agent, 'review-1', 'redeclaring keeps the existing agent id');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Gamma');
  assert.equal(store.verdictsFor(persistent, id)[0].verdict_verifier_family, 'Family Beta', 'a later declaration leaves the old verdict unchanged');
  const rejoined = await runMain(reviewerRoot, ['join', 'review', '--json']);
  assert.equal(rejoined.code, 0, rejoined.stderr || rejoined.stdout);
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Gamma', 'omitting --family preserves the declaration');
  const historicalShow = await runMain(repo, ['show', String(id)]);
  assert.match(historicalShow.stdout, /ACCEPT CRITERION_MET by review-1 \(Family Beta\)/);

  const resumed = await runMain(builderPath, ['resume']);
  assert.match(resumed.stdout, /resume: web-1 \(Family Alpha\), web lane/);
  const resumedJson = await runMain(builderPath, ['resume', '--json']);
  assert.equal(resumedJson.code, 0, resumedJson.stderr || resumedJson.stdout);
  const resumedShape = JSON.parse(resumedJson.stdout);
  assertJsonShape(resumedShape, 'resume');
  assert.equal(resumedShape.me.family, 'Family Alpha');

  const unverified = store.addItem(persistent, { by: 'coordinator', lane: 'review', title: 'No-family verdict' });
  store.claim(persistent, unverified, { agentId: 'review-1', lane: 'review', leaseMs: 2 * HOUR, freeze: familyFreeze });
  store.submit(persistent, unverified, { agentId: 'review-1', commit: SHA_B, tree: 'tree-b' });
  store.verify(persistent, unverified, {
    agentId: 'web-2', decision: 'ACCEPT', note: 'checked without a family declaration',
    head: SHA_B, digest: 'digest:family', policy: 'any',
  });
  const [unattributed] = store.verdictsFor(persistent, unverified);
  assert.equal(unattributed.verdict_verifier_family, null);

  const unclaimed = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'No-family submission' });
  store.claim(persistent, unclaimed, { agentId: 'web-2', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  store.submit(persistent, unclaimed, { agentId: 'web-2', commit: SHA_A, tree: 'tree-c' });
  assert.equal(store.getItem(persistent, unclaimed).item_builder_family, null);

  const differentFamily = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'CLI family review' });
  store.claim(persistent, differentFamily, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  store.submit(persistent, differentFamily, { agentId: 'web-1', commit: SHA_A, tree: 'tree-d' });
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Gamma');
  assert.equal(store.getItem(persistent, unclaimed).item_builder_family, null);
  assert.equal(store.nextFor(persistent, { agentId: 'review-1', lane: 'review', verify: true, familyPolicy: 'require' }).item.item_id, differentFamily);
  const policyConfig = JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: { policy: 'any', family: 'require' },
    lanes: { web: { owns: ['web/'], specs: [] }, review: { owns: ['review/'], specs: [] } }, shared: [],
  });
  writeFileSync(join(repo, 'pullboard.json'), policyConfig);
  writeFileSync(join(reviewerRoot, 'pullboard.json'), policyConfig);
  const cliReview = await runMain(reviewerRoot, ['next', '--verify', '--json']);
  assert.equal(cliReview.code, 0, cliReview.stderr || cliReview.stdout);
  assert.equal(JSON.parse(cliReview.stdout).item.item_id, differentFamily, 'CLI reads verify.family and reserves different-family work');
});

test('[O2,O3] family policy controls review order and refuses unknown or matching families', () => {
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'Family Alpha' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: 'Family Beta' });
  store.register(board, { lane: 'api', path: '/repo-api-1', family: 'Family Beta' });
  const submitAs = (agentId, title) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    store.claim(board, id, { agentId, lane: 'web', leaseMs: HOUR, freeze: () => ({ text: title, digest: 'digest:Page' }) });
    store.submit(board, id, { agentId, commit: SHA_A, tree: `tree-${title}` });
    return id;
  };
  const beta = submitAs('web-2', 'Beta build');
  const alpha = submitAs('web-1', 'Alpha build');
  store.register(board, { lane: 'web', path: '/repo-web-2', family: null });
  const unknown = submitAs('web-2', 'Unknown build');

  assert.equal(store.nextFor(board, { agentId: 'api-1', lane: 'api', verify: true, familyPolicy: 'off' }).item.item_id, beta,
    'off preserves the existing oldest-first review order');
  assert.equal(store.nextFor(board, { agentId: 'api-1', lane: 'api', verify: true, familyPolicy: 'prefer' }).item.item_id, alpha,
    'prefer puts the known different family ahead of a matching or unknown family');
  assert.equal(store.nextFor(board, { agentId: 'api-1', lane: 'api', verify: true, familyPolicy: 'require' }).item.item_id, alpha,
    'require offers only work with a known different family');
  assert.throws(() => store.verify(board, beta, {
    agentId: 'api-1', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Page', policy: 'any', familyPolicy: 'require',
    note: 'checked family policy',
  }), /O2_FAMILY_MATCH.*ask the coordinator/);
  assert.throws(() => store.verify(board, unknown, {
    agentId: 'api-1', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Page', policy: 'any', familyPolicy: 'require',
    note: 'checked unknown builder family',
  }), /O2_FAMILY_MATCH/);
  assert.equal(store.reserveNextReview(board, {
    agentId: 'api-1', lane: 'api', leaseMs: HOUR, policy: 'any', familyPolicy: 'require',
  }).item.item_id, alpha, 'reservation uses the same family filter as next --verify');
  assert.equal(store.verify(board, alpha, {
    agentId: 'api-1', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Page', policy: 'any', familyPolicy: 'require',
    note: 'verified from a different declared family',
  }).decision, 'ACCEPT', 'a different-family verifier can complete the verdict');

  store.register(board, { lane: 'api', path: '/repo-api-1', family: null });
  const unknownVerifierTarget = submitAs('web-1', 'Unknown verifier target');
  assert.equal(store.nextFor(board, { agentId: 'api-1', lane: 'api', verify: true, familyPolicy: 'require' }).item, null,
    'an unknown verifier family counts as a match under require');
  assert.throws(() => store.verify(board, unknownVerifierTarget, {
    agentId: 'api-1', decision: 'ACCEPT', head: SHA_A, digest: 'digest:Page', policy: 'any', familyPolicy: 'require',
    note: 'checked unknown verifier family',
  }), /O2_FAMILY_MATCH/);
});
