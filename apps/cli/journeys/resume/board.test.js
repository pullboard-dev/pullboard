/** @pullboard-test-loads packages/state/src/io/engine.js */
/**
 * The board's rules on an in-memory board with a hand-turned clock (B4–B7, V1, V2, V5, V6, V8, R1,
 * R2). The git-facing rules (V3, V4, V7) run against real repos in e2e.test.js.
 */
import { runMain } from '../../tests/fixtures/board/cli.js';
import { assertJsonShape } from '../../tests/fixtures/board/cli.js';
import * as clauseFixture from '../../tests/fixtures/clause.js';
import {
  repositoryBoardFile,
  submitFixture,
} from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beforeEach,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  addMilestone,
  editMilestoneItems,
  moveMilestone,
  editMilestone,
  roadmap,
  removeMilestone,
} from '../../../../packages/store/index.js';
import { registerPreGrant } from '../../tests/fixtures/seats.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { projectState } from '../../src/io/view.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { briefFiles } from '../../../../packages/items/index.js';
import {
  AUTO_ESCALATE_ENGINE,
  ENGINE_VERSION,
  STRONG_REJECTION_NOTICE_ENGINE,
} from '../../../../packages/state/index.js';
import { MILESTONE_PLACEMENT_ENGINE } from '../../../../packages/state/light.js';
import { ROUTE_CALIBRATION_ENGINE } from '../../../../packages/state/light.js';
import { pathToFileURL } from 'node:url';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../packages/state/light.js';
import {
  verifyLegacyUnknownFamily,
  familyFreeze,
} from '../../tests/fixtures/review/family.js';

const HOUR = 3_600_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
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
  board = openBoard(':memory:', clock);
  registerPreGrant(board, [['coordinator', '/repo', { family: 'Fixture Coordinator' }], ['web', '/repo-web-1', { family: 'Fixture Builder One' }], ['web', '/repo-web-2', { family: 'Fixture Builder Two' }], ['api', '/repo-api-1', { family: 'Fixture Reviewer' }]]);
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

test('agents are numbered per lane; one coordinator; a worktree joins once [B3]', () => {
  assert.deepEqual(store.listAgents(board).map((agent) => agent.agent_id), ['coordinator', 'web-1', 'web-2', 'api-1']);
  assert.equal(store.register(board, { lane: 'web', path: '/repo-web-1' }), 'web-1');
  assert.throws(() => store.register(board, { lane: 'api', path: '/repo-web-1' }), /ALREADY_JOINED/);
  assert.throws(() => store.register(board, { lane: 'coordinator', path: '/elsewhere' }), /ONE_COORDINATOR/);
});

test('[O8] model labels follow stable agent ids into moves and configured display names', () => {
  const id = store.register(board, { lane: 'api', path: '/repo-api-2', model: 'gpt-6-luna' });
  assert.equal(id, 'api-2');
  assert.equal(store.agentAt(board, '/repo-api-2').agent_model, 'gpt-6-luna');
  assert.equal(displayAgentName(store.agentAt(board, '/repo-api-2')), 'api-2 (gpt-6-luna)');
  assert.equal(displayAgentName(store.agentAt(board, '/repo-api-2'), 'prefix'), 'gpt-6-luna-api-2');
  assert.equal(displayAgentName(store.agentAt(board, '/repo-web-1')), 'web-1 (unknown)');
  assert.equal(displayAgentName(store.agentAt(board, '/repo-web-1'), 'prefix'), 'unknown-web-1');
  const id2 = store.register(board, { lane: 'api', path: '/repo-api-2' });
  assert.equal(id2, id, 'omitting model on a repeat registration preserves it and the stable id');
  const joined = store.events(board).find((event) => event.event_kind === 'join' && event.event_by === id);
  assert.equal(JSON.parse(joined.event_detail).model, 'gpt-6-luna');
  store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Model event' });
  store.claim(board, 1, { agentId: id, lane: 'api', leaseMs: HOUR, freeze });
  const claim = store.events(board, { itemId: 1 }).find((event) => event.event_kind === 'claim');
  assert.equal(JSON.parse(claim.event_detail).model, 'gpt-6-luna', 'moves retain the declared model in their event receipt');
  const legacyItem = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Legacy model' });
  store.claim(board, legacyItem, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze });
  const legacyClaim = store.events(board, { itemId: legacyItem }).find((event) => event.event_kind === 'claim');
  assert.equal(JSON.parse(legacyClaim.event_detail).model, 'unknown', 'moves by older agents record their missing model explicitly');
});

test('the coordinator follows the main checkout when the repo moves [B3,B34]', () => {
  assert.equal(store.board_ensureCoordinator(board, '/moved/repo'), 'coordinator');
  assert.equal(store.agentAt(board, '/moved/repo').agent_id, 'coordinator');
});

test('[N26,A2] milestones stay ordered and only the coordinator can edit them', () => {
  const first = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Build' });
  const second = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Publish' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Release', note: 'Ship it', items: [first] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Aftercare', items: [second] });
  editMilestoneItems(board, 'Release', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [second] });
  assert.deepEqual(store.milestones(board).find(({ name }) => name === 'Release').items, [first, second], 'adding preserves item order');
  editMilestoneItems(board, 'Release', { agentId: 'coordinator', remove: [second] });
  assert.deepEqual(store.milestones(board).find(({ name }) => name === 'Release').items, [first], 'removing preserves the remaining order');
  // Adding to Release moves the item, so return it for the roadmap lifecycle checks.
  editMilestoneItems(board, 'Aftercare', { agentId: 'coordinator', add: [second], reason: 'Restore fixture release' });
  moveMilestone(board, 'Aftercare', { agentId: 'coordinator', before: 'Release' });
  editMilestone(board, 'Aftercare', { agentId: 'coordinator', newName: 'Maintenance', note: 'Keep watching' });
  assert.deepEqual(store.milestones(board).map(({ name }) => name), ['Maintenance', 'Release']);
  assert.throws(() => addMilestone(board, { agentId: 'web-1', name: 'Forbidden' }), /COORDINATOR_ONLY/);

  claimAs(second, 'api-1', 'api');
  const current = roadmap(board);
  assert.deepEqual(current.map(({ name, done, total }) => ({ name, done, total })), [
    { name: 'Maintenance', done: 0, total: 1 },
    { name: 'Release', done: 0, total: 1 },
  ]);
  assert.equal(current[0].items[0].status, 'claimed', "roadmap reads the item's current state");
  submitFixture(board, second, { agentId: 'api-1', commit: SHA_A, tree: 'tree-a' });
  store.verify(board, second, {
    agentId: 'web-2', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'checked the expected result',
    head: SHA_A, digest: 'digest:Publish', policy: 'any',
  });
  assert.equal(roadmap(board)[0].done, 0, 'done counts only landed work, so a verified item is not done yet');
  assert.equal(roadmap(board)[0].items[0].state, 'accepted', 'a verified item that has not landed reads as accepted');
  store.merged(board, second, { agentId: 'coordinator', commit: SHA_A });
  assert.equal(roadmap(board)[0].done, 1, 'done counts the item once its merge onto main is recorded');
  removeMilestone(board, 'Maintenance', { agentId: 'coordinator' });
  assert.deepEqual(store.milestones(board).map(({ name }) => name), ['Release']);
  assert.equal(store.getItem(board, second).item_status, 'verified', 'removing a milestone leaves its item untouched');
});

test('[H3,H16] captured milestone operations replay identically on SQLite replicas', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-milestone-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = { now: () => new Date('2026-10-08T00:00:00.000Z') };
  const left = openBoard(join(directory, 'left.sqlite'), clock);
  const right = openBoard(join(directory, 'right.sqlite'), clock);
  t.after(() => { store.closeBoard(left); store.closeBoard(right); });
  for (const replica of [left, right]) {
    store.register(replica, { lane: 'coordinator', path: '/repo' });
    store.register(replica, { lane: 'app', path: '/repo-app' });
    store.addItem(replica, { by: 'coordinator', lane: 'app', title: 'Build' });
    store.addItem(replica, { by: 'coordinator', lane: 'app', title: 'Publish' });
    replica.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run('a'.repeat(32), 'board_id');
  }
  const operations = [
    ['addMilestone', [{ agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Release', note: 'Ship', items: [1] }]],
    ['addMilestone', [{ agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Aftercare', items: [2] }]],
    ['editMilestoneItems', ['Aftercare', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [1] }]],
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
  assert.deepEqual(roadmap(left), roadmap(right));
  assert.deepEqual(exportBoard(left), exportBoard(right), 'native exports include matching metadata and replay receipts');
  assert.equal(roadmap(left)[0].items[0].status, 'claimed');
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

test('the first claim freezes the criterion; later claims keep it [V2]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  assert.equal(claimAs(id, 'web-1', 'web').digest, 'digest:Page');
  store.release(board, id, 'web-1', 'Hand the frozen criterion to another builder.', 'OTHER');
  const other = (item) => ({ text: 'changed', digest: `other:${item.item_id}` });
  store.claim(board, id, { agentId: 'web-2', lane: 'web', leaseMs: HOUR, freeze: other });
  assert.equal(store.getItem(board, id).item_frozen_digest, 'digest:Page');
});

test('submit needs your claim and finished children [V4]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Part', parentId: id });
  assert.throws(() => submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' }), /NOT_YOURS/);
  claimAs(id, 'web-1', 'web');
  assert.throws(() => submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' }), /CHILDREN_OPEN/);
  store.withdraw(board, child, { agentId: 'coordinator', reason: 'folded into the parent' });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.equal(store.getItem(board, id).item_status, 'submitted');
});

/**
 * An item built by web-1 and submitted at SHA_A.
 */
function submitted() {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
  return id;
}

/** Pass this test's current board to the unchanged verdict fixture defaults. */
const verdict = (id, fields) => clauseFixture.verifyFrozenFixture(board, id, fields);

/** Submit one new revision and record its rejection on the item's real SQLite board [B15,V6].
 *
 * @param {number} id
 * @param {string} commit
 * @param {string} note
 */
function rejectRevision(id, commit, note) {
  if (store.getItem(board, id).item_status === 'open') claimAs(id, 'web-1', 'web');
  const item = store.getItem(board, id);
  submitFixture(board, id, { agentId: 'web-1', commit, tree: `tree-${commit[0]}` });
  verdict(id, {
    agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note,
    head: commit, digest: `digest:${item.item_title}`,
  });
}

test('the builder never verifies its own work [V1]', () => {
  const id = submitted();
  assert.throws(() => verdict(id, { agentId: 'web-1', decision: 'ACCEPT' }), /SELF_VERIFY/);
  assert.equal(verdict(id, { agentId: 'web-2', decision: 'ACCEPT' }).reason, 'CRITERION_MET');
});

/** A verifier can release its live review reservation for another verifier [V15]. */
test('a verifier releases its reserved review; another verifier can take it, and claims still release [V15]', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-review-release-'));
  const durable = openBoard(repositoryBoardFile(directory), clock);
  try {
    store.register(durable, { lane: 'coordinator', path: '/repo' });
    const builder = store.register(durable, { lane: 'web', path: '/repo-web-1', family: 'Fixture Builder' });
    const reviewer = store.register(durable, { lane: 'web', path: '/repo-web-2', family: 'Fixture Reviewer' });
    const second = store.register(durable, { lane: 'web', path: '/repo-web-3', family: 'Fixture Reviewer Two' });
    const third = store.register(durable, { lane: 'web', path: '/repo-web-4', family: 'Fixture Reviewer Three' });
    const id = store.addItem(durable, { by: 'coordinator', lane: 'web', title: 'Page' });
    store.claim(durable, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(durable, id, { agentId: builder, commit: SHA_A, tree: 'tree-a' });
    store.reserveReview(durable, id, { agentId: reviewer, leaseMs: HOUR, policy: 'any' });

    assert.equal(store.release(durable, id, reviewer, 'wrong tree', 'OTHER'), true);
    assert.deepEqual(
      [store.getItem(durable, id).item_review_by, store.getItem(durable, id).item_review_until],
      [null, null],
    );
    assert.equal(store.events(durable, { itemId: id }).at(-1).event_kind, 'release');
    assert.equal(store.reserveReview(durable, id, { agentId: second, leaseMs: HOUR, policy: 'any' }).item_review_by, second);
    assert.throws(() => store.release(durable, id, third, 'Another verifier holds this reservation.', 'OTHER'), /NOT_YOURS/);

    const claimed = store.addItem(durable, { by: 'coordinator', lane: 'web', title: 'Another page' });
    store.claim(durable, claimed, { agentId: reviewer, lane: 'web', leaseMs: HOUR, freeze });
    assert.equal(store.release(durable, claimed, reviewer, 'Return the fixture claim to the queue.', 'OTHER'), false);
    assert.equal(store.getItem(durable, claimed).item_status, 'open');
  } finally {
    store.closeBoard(durable);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('under verify: coordinator, lane work is the coordinator\'s to verify [V9]', () => {
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
  assert.throws(() => submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' }), /HEAD_NOT_NEW/);
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_B, tree: 'tree-b' });
  verdict(id, { agentId: 'web-2', decision: 'ACCEPT' });
  assert.equal(store.getItem(board, id).item_status, 'verified');
});

test('a rejected commit resubmits after its bar is corrected [V4,B3]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-corrected-reject-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  let durable;
  t.after(() => {
    if (durable) store.closeBoard(durable);
    rmSync(directory, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Pullboard Test'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'pullboard-test@example.com'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'page.html'), '<h1>Page</h1>\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ lanes: {} }));
  execFileSync('git', ['add', 'page.html', 'pullboard.json'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'feat(web): render a page [G1]'], { cwd: repo, stdio: 'pipe' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();

  durable = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'), clock);
  store.register(durable, { lane: 'coordinator', path: repo });
  const builder = store.register(durable, { lane: 'web', path: join(directory, 'web-1'), family: 'Fixture Builder' });
  const reviewer = store.register(durable, { lane: 'web', path: join(directory, 'web-2'), family: 'Fixture Reviewer' });
  /** Freeze the current criterion deterministically for this real-board replay test. */
  const criterionFreeze = (item) => ({ text: item.item_criterion, digest: `digest:${item.item_criterion}` });
  assert.ok(ENGINE_VERSION >= 9, 'engine 9 introduces corrected-bar resubmission');
  const id = store.addItem(durable, {
    by: 'coordinator', lane: 'web', title: 'Page', criterion: 'the page renders its heading',
  });
  const originalClaim = store.claim(durable, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze: criterionFreeze });
  submitFixture(durable, id, { agentId: builder, commit, tree });
  store.verify(durable, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
    clause: 'the page renders its heading', note: 'the heading is missing', head: commit, digest: originalClaim.digest, policy: 'any',
  });

  store.claim(durable, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze: criterionFreeze });
  assert.throws(
    () => submitFixture(durable, id, { agentId: builder, commit, tree }),
    (error) => error.code === 'HEAD_NOT_NEW',
    'the same rejected head is still refused while its criterion is unchanged',
  );
  store.editItem(durable, id, { agentId: 'coordinator', criterion: 'the page renders an accessible heading', reason: 'the fixture corrects its bar' });
  const correction = store.refreeze(durable, id, { agentId: 'coordinator', freeze: criterionFreeze });
  assert.notEqual(correction.after, originalClaim.digest);
  assert.equal(store.getItem(durable, id).item_owner, builder, 'refreeze keeps the builder claim for the corrected bar');

  assert.doesNotThrow(
    () => submitFixture(durable, id, { agentId: builder, commit, tree }),
    'the rejected commit is resubmitted unchanged after the coordinator corrects the criterion',
  );
  const item = store.getItem(durable, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, commit);
  assert.equal(item.item_frozen_digest, correction.after, 'the resubmission is recorded against the new criterion digest');
  const rejects = store.verdictsFor(durable, id).filter((entry) => entry.verdict_decision === 'REJECT');
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].verdict_commit, commit);
  assert.equal(rejects[0].verdict_digest, originalClaim.digest, 'the original rejection remains bound to its original bar');
  assert.equal(store.events(durable, { itemId: id }).filter((event) => event.event_kind === 'reject').length, 1);
  const resubmission = JSON.parse(store.events(durable, { itemId: id }).at(-1).event_detail);
  assert.equal(resubmission.commit, commit);
  assert.equal(resubmission.criterionDigest, correction.after, 'the engine-9 submit event names its corrected frozen digest');
  store.verify(durable, id, {
    agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
    clause: 'the page renders an accessible heading', note: 'the corrected criterion still fails', head: commit, digest: correction.after, policy: 'any',
  });
  store.claim(durable, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze: criterionFreeze });
  assert.throws(
    () => submitFixture(durable, id, { agentId: builder, commit, tree }),
    (error) => error.code === 'HEAD_NOT_NEW',
    'engine 9 refuses the same commit after a rejection at the unchanged corrected digest',
  );
  const allRejects = store.verdictsFor(durable, id).filter((entry) => entry.verdict_decision === 'REJECT');
  assert.equal(allRejects.length, 2);
  assert.equal(allRejects[1].verdict_digest, correction.after);

  const legacy = [
    openBoard(join(directory, 'engine-8-source.sqlite'), clock),
    openBoard(join(directory, 'engine-8-replica.sqlite'), clock),
  ];
  t.after(() => legacy.forEach((replica) => store.closeBoard(replica)));
  const oldIds = legacy.map((replica) => {
    const [, oldBuilder] = registerPreGrant(replica, [['coordinator', '/legacy/repo'], ['web', '/legacy/web-1'], ['web', '/legacy/web-2']]);
    return { oldBuilder, oldItem: store.addItem(replica, {
      by: 'coordinator', lane: 'web', title: 'Legacy page', criterion: 'the page renders its heading',
    }) };
  });
  for (const replica of legacy) {
    replica.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run('8'.repeat(32), 'board_id');
  }
  const legacyClientDirectory = join(directory, 'engine-8-client');
  mkdirSync(legacyClientDirectory);
  unpackRelease('v0.8.6', legacyClientDirectory);
  const legacyEngine = await import(pathToFileURL(join(legacyClientDirectory, 'src/engine.js')).href);
  /** Freeze an engine-8 item with its captured verify policy, as released boards require. */
  const legacyFreeze = (item) => ({
    text: JSON.stringify({
      criterion: item.item_criterion,
      policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } },
    }),
    digest: `digest:${item.item_criterion}`,
  });
  const oldMoves = [
    ['claim', (replica, ids) => [ids.oldItem, { agentId: ids.oldBuilder, lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]],
    ['submit', (replica, ids) => [ids.oldItem, { agentId: ids.oldBuilder, commit, tree }]],
    ['verify', (replica, ids) => [ids.oldItem, { agentId: 'web-2', decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'heading missing', head: commit, digest: 'digest:the page renders its heading', policy: 'any' }]],
    ['claim', (replica, ids) => [ids.oldItem, { agentId: ids.oldBuilder, lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]],
    ['editItem', (replica, ids) => [ids.oldItem, { agentId: 'coordinator', criterion: 'the page renders an accessible heading' }]],
    ['refreeze', (replica, ids) => [ids.oldItem, { agentId: 'coordinator', freeze: legacyFreeze }]],
    ['submit', (replica, ids) => [ids.oldItem, { agentId: ids.oldBuilder, commit, tree }]],
  ];
  let finalLegacyOutcome;
  oldMoves.forEach(([operation, argsFor], index) => {
    const args = argsFor(legacy[0], oldIds[0]);
    const move = legacyEngine.prepareEngineMove(legacy[0], operation, args, { id: `engine-8-resubmit-${index}` });
    assert.equal(move.engine, 8);
    const receipt = { sequence: index + 1, at: `2026-10-11T16:00:0${index}.000Z` };
    const sourceOutcome = legacyEngine.applyEngineMove(legacy[0], move, receipt);
    const replicaOutcome = applyEngineMove(legacy[1], move, receipt);
    assert.deepEqual(sourceOutcome, replicaOutcome, `engine-8 move ${operation} replays identically`);
    if (index < oldMoves.length - 1) assert.equal(sourceOutcome.error, undefined, `released engine-8 ${operation} applies`);
    if (index === oldMoves.length - 1) finalLegacyOutcome = sourceOutcome;
  });
  assert.equal(finalLegacyOutcome.error.code, 'HEAD_NOT_NEW', 'engine 8 still refuses a rejected commit after refreeze');
  assert.deepEqual(store.events(legacy[0]), store.events(legacy[1]), 'engine-8 event details replay without engine-9 additions');
  assert.ok(store.events(legacy[0]).filter((event) => event.event_kind === 'submit')
    .every((event) => !Object.hasOwn(JSON.parse(event.event_detail), 'criterionDigest')));
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

test('merged and withdraw are the coordinator\'s, and only for the right states [R3]', () => {
  const id = submitted();
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: SHA_B }), /NOT_VERIFIED/);
  verdict(id, { agentId: 'web-2', decision: 'ACCEPT' });
  assert.throws(() => store.merged(board, id, { agentId: 'web-2', commit: SHA_B }), /COORDINATOR_ONLY/);
  store.merged(board, id, { agentId: 'coordinator', commit: SHA_B });
  assert.equal(store.getItem(board, id).item_merged_commit, SHA_B);
  store.withdraw(board, id, { agentId: 'coordinator', reason: 'late' });
  assert.throws(() => store.withdraw(board, id, { agentId: 'coordinator', reason: 'again' }), /CLOSED/);
});

test('shouts reach a lane, an agent or all; inbox marks them read [B7]', () => {
  const lanes = ['coordinator', 'web', 'api'];
  store.shout(board, { from: 'coordinator', to: 'web', text: 'web: rebase', lanes });
  store.shout(board, { from: 'api-1', to: 'web-2', text: 'web-2: schema changed', lanes });
  const report = store.shout(board, { from: 'web-1', to: 'all', text: 'all: gate is slow', lanes });
  assert.equal(store.getShout(board, report).shout_to, 'coordinator+person');
  assert.ok(store.inbox(board, 'coordinator').some(shout => shout.shout_id === report));
  store.shout(board, { from: 'coordinator', to: 'all', text: 'all: gate is slow', lanes });
  assert.throws(() => store.shout(board, { from: 'web-1', to: 'nobody', text: 'x', lanes }), /NO_READER/);
  assert.equal(store.unreadCount(board, 'web-2'), 3);
  assert.deepEqual(store.inbox(board, 'web-2').map((shout) => shout.shout_text), ['web: rebase', 'web-2: schema changed', 'all: gate is slow']);
  assert.equal(store.unreadCount(board, 'web-2'), 0);
  assert.deepEqual(store.inbox(board, 'web-1').map((shout) => shout.shout_text), ['web: rebase', 'all: gate is slow']);
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
  // Before milestone placement (2a3a0f7555) and automatic escalation (d2a669b629) the log holds only the moves themselves.
  board.executionEngineVersion = Math.min(MILESTONE_PLACEMENT_ENGINE, AUTO_ESCALATE_ENGINE) - 1;
  const id = submitted();
  verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'red' });
  const kinds = store.events(board, { itemId: id }).map((event) => `${event.event_by}:${event.event_kind}`);
  assert.deepEqual(kinds, ['coordinator:add', 'web-1:claim', 'web-1:submit', 'web-2:reject']);
  const stats = store.stats(board);
  assert.equal(stats.items.open, 1);
  assert.equal(stats.rejected, 1);
});

test('summary reads expire a held claim at its deadline without changing its stored owner [B4,R1]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'A short claim' });
  claimAs(id, 'web-1', 'web');
  assert.equal(store.stats(board).items.claimed, 1);
  assert.equal(store.itemsInStatus(board, 'claimed', 'web-1')[0].item_id, id);
  assert.equal(store.itemsInStatus(board, 'claimed', 'web-2').length, 0);
  clock.advance(2 * HOUR);
  assert.deepEqual(store.stats(board).items, { open: 1, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 });
  assert.deepEqual(store.itemsInStatus(board, 'claimed', 'web-1'), []);
  assert.equal(store.getItem(board, id).item_status, 'open');
  const stored = board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(id);
  assert.equal(stored.item_status, 'claimed');
  assert.equal(stored.item_owner, 'web-1');
});

test('an item can wait on others: claiming it is refused until they are verified [B8]', () => {
  const contract = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Store module' });
  const user = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Uses the store', after: [contract] });
  assert.throws(() => claimAs(user, 'api-1', 'api'), /BLOCKED.*#2 waits on #1 \(open, web lane\)/);
  claimAs(contract, 'web-1', 'web');
  submitFixture(board, contract, { agentId: 'web-1', commit: SHA_A, tree: 't' });
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
    const old = openBoard(file, clock);
    for (const column of ['item_after', 'item_brief', 'item_route', 'item_check', 'item_claim_head', 'item_files', 'item_builder_family']) old.db.exec(`ALTER TABLE item DROP COLUMN ${column}`);
    for (const column of ['agent_route', 'agent_family']) old.db.exec(`ALTER TABLE agent DROP COLUMN ${column}`);
    old.db.exec('ALTER TABLE verdict DROP COLUMN verdict_verifier_family');
    old.db.exec('DROP TABLE hold');
    // An older version's board carries an older user_version; only that makes an open migrate (#1047).
    old.db.exec('PRAGMA user_version = 0');
    store.closeBoard(old);
    const reopened = openBoard(file, clock);
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
  submitFixture(board, contract, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web', verify: true }).item, null);
  assert.equal(store.nextFor(board, { agentId: 'web-2', lane: 'web', verify: true }).item.item_id, contract);
  assert.deepEqual(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).reasons, [
    `no open items in the web lane; #${contract} still awaits a verdict, and a rejected item comes back to this lane. A lane is done when its items are verified`,
  ]);
  store.verify(board, contract, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the contract test fails', clause: 'Contract', head: SHA_A, digest: 'digest:Contract', policy: 'any' });
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
  assert.throws(() => store.editItem(board, id, { agentId: 'api-1', brief: 'mine now' }), /HELD.*coordinator/);
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator' }), /USAGE/);
  assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Huge', brief: 'x'.repeat(8001) }), /BRIEF_TOO_LONG/);
  assert.deepEqual(JSON.parse(store.events(board, { itemId: id }).find((event) => event.event_kind === 'edit').event_detail), { brief: '38 characters', model: 'unknown' });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
  store.verify(board, id, { agentId: 'web-2', decision: 'ACCEPT', head: SHA_A, digest, policy: 'any', note: 'removed the help case; its test failed' });
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', brief: 'late' }), /CLOSED/);
});

const BRIEF = 'Files:\n- web/a.js\nChange:\n- rename x to y\nTest:\n- test/a.test.js asserts y is exported\nOut of scope: anything else';

/**
 * Add a web item routed below strong, complete unless a field is overridden.
 */
const DIAGNOSIS = 'Files: web/a.js Change: rename x to y Test case: test/a.test.js asserts y is exported';
/**
 * Add a web item at a route; light work is added mid, then diagnosed by the coordinator, as the
 * diagnosis rule of 7a964958ab and the mid default of e552095cfa require [B13,C7].
 */
const routed = (title, route, extra = {}) => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, route: route === 'light' ? 'mid' : route, brief: BRIEF, criterion: 'y is exported', check: 'node --test', ...extra });
  if (route === 'light') store.appendFact(board, id, { agentId: 'coordinator', kind: 'diagnosis', text: DIAGNOSIS });
  return id;
};

test('routes are tiers: an agent claims and verifies its tier and below, its own first [B13]', () => {
  store.register(board, { lane: 'web', path: '/repo-web-3', route: 'light' });
  store.register(board, { lane: 'web', path: '/repo-web-4', route: 'mid' });
  assert.throws(() => store.register(board, { lane: 'web', path: '/repo-web-3' }), /ALREADY_JOINED.*routed light/);
  assert.throws(() => store.register(board, { lane: 'web', path: '/repo-web-9', route: 'cheap' }), /BAD_ROUTE/);
  const light = routed('Rename', 'light');
  const mid = routed('Small feature', 'mid');
  const strong = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Design the cache', route: 'strong' });
  assert.throws(() => claimAs(strong, 'web-3', 'web'), /ROUTE.*needs a strong model; you joined on the light route/);
  assert.throws(() => claimAs(mid, 'web-3', 'web'), /ROUTE.*needs a mid model/);
  assert.equal(store.nextFor(board, { agentId: 'web-3', lane: 'web' }).item.item_id, light);
  assert.equal(store.nextFor(board, { agentId: 'web-4', lane: 'web' }).item.item_id, mid);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, strong);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web', runnable: true }).item.item_id, mid);
  assert.equal(store.nextFor(board, { agentId: 'web-4', lane: 'web', routes: ['light'] }).item.item_id, light);
  claimAs(strong, 'web-1', 'web');
  assert.throws(() => store.editItem(board, strong, { agentId: 'coordinator', route: 'mid' }), /HELD.*only while it is open/);
  submitFixture(board, strong, { agentId: 'web-1', commit: SHA_A, tree: 't' });
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
  const id = routed('Rename', 'mid');
  assert.throws(() => store.editItem(board, id, { agentId: 'coordinator', brief: '' }), /NO_BRIEF/);
  assert.equal(store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Loose', route: 'strong' }) > id, true);
});

test('changing a criterion or a check drops the frozen bar, in the open; the next claim freezes anew [B14]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  claimAs(id, 'web-1', 'web');
  store.release(board, id, 'web-1', 'Release the claim before correcting its criterion.', 'OTHER');
  store.editItem(board, id, { agentId: 'coordinator', check: 'npm test', criterion: 'renders', reason: 'the fixture corrects its bar' });
  assert.equal(store.getItem(board, id).item_frozen_digest, null);
  const edit = store.events(board, { itemId: id }).find((event) => event.event_kind === 'edit');
  assert.deepEqual(JSON.parse(edit.event_detail), { criterion: 'renders', check: 'npm test', unfrozen: 'digest:Page', reason: 'the fixture corrects its bar', barCorrection: { fields: ['criterion', 'check'], reject: null }, model: 'unknown' });
  assert.equal(claimAs(id, 'web-1', 'web').digest, 'digest:Page');
});

test('edit after an expired claim reopens it and names its holder [B13]', () => {
  const edits = [
    { title: 'Criterion', change: { criterion: 'the new criterion' } },
    { title: 'Check', change: { check: 'node --test' } },
    { title: 'Route', change: { route: 'mid' } },
  ];
  for (const { title, change } of edits) {
    const id = routed(title, change.route ? 'light' : 'mid', { criterion: 'the old criterion', check: 'true' });
    claimAs(id, 'web-1', 'web');
    clock.advance(2 * HOUR + 1);
    assert.doesNotThrow(
      () => store.editItem(board, id, { agentId: 'coordinator', ...change, reason: 'the fixture corrects its bar' }),
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

  const live = routed('Live', 'light', { criterion: 'the old criterion', check: 'true' });
  claimAs(live, 'web-1', 'web');
  const digest = store.itemById(board, live).item_frozen_digest;
  assert.throws(() => store.editItem(board, live, { agentId: 'coordinator', route: 'mid' }), /HELD/);
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
  assert.deepEqual(JSON.parse(first.event_detail), { from: 'light', to: 'mid', note: 'check failed twice', attempt: 'refs/pullboard/attempts/1/abc', model: 'unknown' }, 'the failure and the pinned attempt travel with it');
});

test('two failed attempts at a route escalate the item one route up [B15,B13]', () => {
  const id = routed('Automatic escalation', 'light');
  claimAs(id, 'web-1', 'web');
  store.release(board, id, 'web-1', 'Return the claim without recording a failed attempt.', 'OTHER');
  rejectRevision(id, SHA_A, 'first reject: missing parser output');
  assert.equal(store.getItem(board, id).item_route, 'light', 'a release is not a failed attempt');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 0);

  rejectRevision(id, SHA_B, 'second reject: parser still drops the row');
  const item = store.getItem(board, id);
  assert.deepEqual([item.item_status, item.item_route, item.item_owner], ['open', 'mid', null]);
  const escalations = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate');
  assert.equal(escalations.length, 1, 'the second rejection writes one existing escalation event');
  const detail = JSON.parse(escalations[0].event_detail);
  assert.deepEqual([detail.from, detail.to], ['light', 'mid']);
  assert.equal(detail.rejections.length, 2, 'the single escalation receipt carries both rejections');
  assert.deepEqual(detail.rejections.map((entry) => entry.note), [
    'first reject: missing parser output', 'second reject: parser still drops the row',
  ]);
  assert.deepEqual(detail.rejections.map((entry) => entry.reason), ['TEST_FAILURE', 'TEST_FAILURE']);
  assert.deepEqual(detail.rejections.map((entry) => [entry.commit, entry.head]), [[SHA_A, SHA_A], [SHA_B, SHA_B]]);
  assert.ok(detail.rejections.every((entry) => entry.verdictId && entry.eventId && entry.digest && entry.at));
});

test('a hand escalation starts a new route rejection count [B15,B13]', () => {
  const id = routed('Manual route reset', 'light');
  rejectRevision(id, SHA_A, 'old-route reject');
  assert.equal(store.getItem(board, id).item_route, 'light');
  store.escalate(board, id, { agentId: 'coordinator', note: 'manual route handoff' });

  rejectRevision(id, SHA_B, 'first mid-route reject');
  assert.equal(store.getItem(board, id).item_route, 'mid', 'the prior light rejection does not carry over');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 1);
  clauseFixture.acknowledgeClauseHold(board, id, { agentId: 'coordinator', reason: 'Continue this route-counter fixture after acknowledging the bar hold.' });
  rejectRevision(id, SHA_C, 'second mid-route reject');
  assert.equal(store.getItem(board, id).item_route, 'strong');
  const escalations = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate');
  assert.equal(escalations.length, 2);
  assert.deepEqual(JSON.parse(escalations[1].event_detail).rejections.map((entry) => entry.note), [
    'first mid-route reject', 'second mid-route reject',
  ]);
});

test('a coordinator route edit starts a new rejection count [B15,B13]', () => {
  const id = routed('Edited route reset', 'light');
  rejectRevision(id, SHA_A, 'old light-route reject');
  store.editItem(board, id, { agentId: 'coordinator', route: 'mid' });

  rejectRevision(id, SHA_B, 'first edited mid-route reject');
  assert.equal(store.getItem(board, id).item_route, 'mid');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 0);

  clauseFixture.acknowledgeClauseHold(board, id, { agentId: 'coordinator' });
  rejectRevision(id, SHA_C, 'second edited mid-route reject');
  assert.equal(store.getItem(board, id).item_route, 'strong');
  const escalations = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate');
  assert.equal(escalations.length, 1);
  assert.deepEqual(JSON.parse(escalations[0].event_detail).rejections.map((entry) => entry.note), [
    'first edited mid-route reject', 'second edited mid-route reject',
  ]);
});

test('two send-backs at the strongest route record no escalation [B15,B13,H16]', () => {
  board.executionEngineVersion = ROUTE_CALIBRATION_ENGINE - 1; // 45922a6670 escalates a same-route TEST_FAILURE at once from this engine
  const id = routed('Strong rework notice', 'strong');
  rejectRevision(id, SHA_A, 'first strong send-back: missing output');
  rejectRevision(id, SHA_B, 'second strong send-back: output still wrong');
  const item = store.getItem(board, id);
  assert.deepEqual([item.item_status, item.item_route, item.item_owner, item.item_lease_until], ['open', 'strong', null, null], 'ordinary rejection still reopens without a retained or renewed lease');
  const events = store.events(board, { itemId: id });
  assert.equal(events.filter(event => event.event_kind === 'escalate').length, 0, 'no automatic strong-to-strong route event');
  const rejections = store.verdictsFor(board, id).filter(entry => entry.verdict_decision === 'REJECT');
  const notices = store.allShouts(board).filter(entry => entry.shout_to === 'coordinator' && entry.shout_text.includes(`#${id} has two send-backs at the strongest route`));
  assert.equal(notices.length, 1, 'one coordinator notice for this rejection pair');
  assert.match(notices[0].shout_text, /web-1 built it/u);
  for (const rejection of rejections) assert.ok(notices[0].shout_text.includes(`#${rejection.verdict_id}`), 'the notice names both rejection receipts');
  const rigorNotices = store.allShouts(board).filter(entry => entry.shout_from === 'rigor' && entry.shout_to === 'coordinator' && entry.shout_text.includes('Rigor recorded unproved doctrine draft'));
  assert.equal(rigorNotices.length, 1, 'the repeated refusal cause keeps its independent Rigor notice');
  assert.match(rigorNotices[0].shout_text, new RegExp(`for refusal:TEST_FAILURE, from #${id}\\.`));
  const rigorDraft = store.events(board).find(event => event.event_kind === 'rigor-draft' && event.event_by === 'rigor');
  const rigorDraftDetail = JSON.parse(rigorDraft?.event_detail ?? '{}');
  assert.deepEqual([rigorDraftDetail.target, rigorDraftDetail.cause, rigorDraftDetail.unproved], ['doctrine', 'refusal:TEST_FAILURE', true], 'the independent notice retains its durable Rigor draft event');
  clauseFixture.acknowledgeClauseHold(board, id, { agentId: 'coordinator', reason: 'Continue this route-counter fixture after acknowledging the bar hold.' });
  rejectRevision(id, SHA_C, 'third strong send-back');
  const pairNoticesAfterThird = store.allShouts(board).filter(entry => entry.shout_to === 'coordinator' && entry.shout_text.includes(`#${id} has two send-backs at the strongest route`));
  assert.equal(pairNoticesAfterThird.length, 1, 'one further rejection cannot repeat the pair notice');
  rejectRevision(id, SHA_D, 'fourth strong send-back');
  const pairNoticesAfterFourth = store.allShouts(board).filter(entry => entry.shout_to === 'coordinator' && entry.shout_text.includes(`#${id} has two send-backs at the strongest route`));
  assert.equal(pairNoticesAfterFourth.length, 2, 'a new pair gets its own single notice');
  const nextRejections = store.verdictsFor(board, id).filter(entry => entry.verdict_decision === 'REJECT').slice(-2);
  for (const rejection of nextRejections) assert.ok(pairNoticesAfterFourth[1].shout_text.includes(`#${rejection.verdict_id}`));
  assert.equal(store.events(board, { itemId: id }).filter(event => event.event_kind === 'escalate').length, 0);
});

test('an item at strong stays at strong after more failures [B15,B13]', () => {
  board.executionEngineVersion = AUTO_ESCALATE_ENGINE;
  const id = routed('Strong ceiling', 'strong');
  rejectRevision(id, SHA_A, 'strong reject one');
  rejectRevision(id, SHA_B, 'strong reject two');
  assert.equal(store.getItem(board, id).item_route, 'strong');
  rejectRevision(id, SHA_C, 'strong reject three');
  rejectRevision(id, SHA_D, 'strong reject four');
  assert.equal(store.getItem(board, id).item_route, 'strong');
  const escalations = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate');
  assert.equal(escalations.length, 2, 'each pair records one ceiling escalation');
  assert.ok(escalations.every((event) => {
    const detail = JSON.parse(event.event_detail);
    return detail.from === 'strong' && detail.to === 'strong' && detail.rejections.length === 2;
  }));
});

for (const version of [50, 51, 52, 53, STRONG_REJECTION_NOTICE_ENGINE]) {
  test(`engine ${version} ceiling send-backs replay identically on replicas [B15,H16]`, (t) => {
    const id = routed('Recorded ceiling behavior', 'strong');
    const copy = openBoard(':memory:', clock);
    t.after(() => store.closeBoard(copy));
    importBoard(copy, exportBoard(board));
    const frozen = item => ({ text: JSON.stringify({ criterion: item.item_criterion,
      policy: { version: 1, commit: SHA_A, verify: { policy: 'any', family: 'off' } } }), digest: `digest:${item.item_title}` });
    const proof = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic replay fixture' };
    let sequence = 0;
    let latest;
    const apply = (operation, args) => {
      sequence += 1;
      latest = { ...prepareEngineMove(board, operation, args, { id: `ceiling-${version}-${sequence}` }), engine: version };
      for (const replica of [board, copy]) {
        const result = applyEngineMove(replica, latest, { sequence, at: `2026-10-18T00:00:0${sequence}.000Z` });
        assert.equal(result.error, undefined, `${operation} applies at engine ${version}`);
      }
    };
    for (const [commit, note] of [[SHA_A, 'first send-back'], [SHA_B, 'second send-back']]) {
      apply('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: frozen }]);
      apply('submit', [id, { agentId: 'web-1', commit, tree: `tree-${commit[0]}`, submissionProof: proof }]);
      apply('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note,
        head: commit, digest: 'digest:Recorded ceiling behavior', policy: 'any' }]);
    }
    const events = store.events(board, { itemId: id });
    const current = version >= STRONG_REJECTION_NOTICE_ENGINE;
    assert.equal(events.filter(event => event.event_kind === 'escalate').length, current ? 0 : 1, 'old engine50..53 retains its recorded ceiling event');
    assert.equal(events.filter(event => event.event_kind === 'strong-rejection-notice').length, current ? 1 : 0);
    assert.equal(store.allShouts(board).length, current ? 1 : 0);
    assert.deepEqual(store.getItem(copy, id), store.getItem(board, id));
    assert.deepEqual(store.events(copy), store.events(board));
    assert.deepEqual(store.allShouts(copy), store.allShouts(board));
    const before = exportBoard(board);
    applyEngineMove(board, latest, { sequence, at: `2026-10-18T00:00:0${sequence}.000Z` });
    assert.deepEqual(exportBoard(board), before, 'replaying the exact receipt cannot duplicate the notice');
  });
}

test('engine 40 reject moves replay without automatic escalation [B15,H16]', () => {
  const id = routed('Legacy engine', 'light');
  const legacyFreeze = (item) => ({
    text: JSON.stringify({
      criterion: item.item_criterion,
      policy: { version: 1, commit: SHA_A, verify: { policy: 'any', family: 'off' } },
    }),
    digest: `digest:${item.item_title}`,
  });
  const submissionProof = {
    version: 1, files: [], full: false, deferred: true,
    reason: 'synthetic board-state fixture; no gate execution',
  };
  let sequence = 0;
  const applyLegacyMove = (operation, args) => {
    sequence += 1;
    const move = prepareEngineMove(board, operation, args, { id: `engine-40-auto-escalation-${sequence}` });
    move.engine = 40;
    const result = applyEngineMove(board, move, { sequence, at: `2026-10-18T00:00:0${sequence}.000Z` });
    assert.equal(result.error, undefined, `${operation} replays on engine 40`);
  };
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject one', head: SHA_A, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_B, tree: 'tree-b', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject two', head: SHA_B, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  assert.equal(store.getItem(board, id).item_route, 'light');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 0);
});

test('engine 43 reject moves replay without automatic escalation [B15,H16]', () => {
  const id = routed('Legacy engine', 'light');
  const legacyFreeze = (item) => ({
    text: JSON.stringify({
      criterion: item.item_criterion,
      policy: { version: 1, commit: SHA_A, verify: { policy: 'any', family: 'off' } },
    }),
    digest: `digest:${item.item_title}`,
  });
  const submissionProof = {
    version: 1, files: [], full: false, deferred: true,
    reason: 'synthetic board-state fixture; no gate execution',
  };
  let sequence = 0;
  const applyLegacyMove = (operation, args) => {
    sequence += 1;
    const move = prepareEngineMove(board, operation, args, { id: `engine-43-auto-escalation-${sequence}` });
    move.engine = 43;
    const result = applyEngineMove(board, move, { sequence, at: `2026-10-18T00:00:0${sequence}.000Z` });
    assert.equal(result.error, undefined, `${operation} replays on engine 43`);
  };
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject one', head: SHA_A, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_B, tree: 'tree-b', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject two', head: SHA_B, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  assert.equal(store.getItem(board, id).item_route, 'light');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 0);
});

test('engine 49 reject moves replay without automatic escalation [B15,H16]', () => {
  const id = routed('Legacy engine', 'light');
  const legacyFreeze = (item) => ({
    text: JSON.stringify({
      criterion: item.item_criterion,
      policy: { version: 1, commit: SHA_A, verify: { policy: 'any', family: 'off' } },
    }),
    digest: `digest:${item.item_title}`,
  });
  const submissionProof = {
    version: 1, files: [], full: false, deferred: true,
    reason: 'synthetic board-state fixture; no gate execution',
  };
  let sequence = 0;
  const applyLegacyMove = (operation, args) => {
    sequence += 1;
    const move = prepareEngineMove(board, operation, args, { id: `engine-49-auto-escalation-${sequence}` });
    move.engine = 49;
    const result = applyEngineMove(board, move, { sequence, at: `2026-10-18T00:00:0${sequence}.000Z` });
    assert.equal(result.error, undefined, `${operation} replays on engine 49`);
  };
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject one', head: SHA_A, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  applyLegacyMove('claim', [id, { agentId: 'web-1', lane: 'web', leaseMs: HOUR, freeze: legacyFreeze }]);
  applyLegacyMove('submit', [id, { agentId: 'web-1', commit: SHA_B, tree: 'tree-b', submissionProof }]);
  applyLegacyMove('verify', [id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'legacy reject two', head: SHA_B, digest: `digest:${store.getItem(board, id).item_title}`, policy: 'any' }]);
  assert.equal(store.getItem(board, id).item_route, 'light');
  assert.equal(store.events(board, { itemId: id }).filter((event) => event.event_kind === 'escalate').length, 0);
});

test('a fresh claim records where the work started; submit records what it changed, reworks included [N21]', () => {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const claimAt = (head) => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, head });
  claimAt(SHA_A);
  claimAt(SHA_B);
  assert.equal(store.getItem(board, id).item_claim_head, SHA_A, 'a renewal keeps the first head');
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_B, tree: 't', files: ['web/page.js', 'web/page.test.js'] });
  verdict(id, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE', note: 'an empty page throws' });
  claimAt(SHA_B);
  assert.equal(store.getItem(board, id).item_claim_head, SHA_B, 'the rework starts from the rejected head');
  submitFixture(board, id, { agentId: 'web-1', commit: 'c'.repeat(40), tree: 't2', files: ['web/page.js', 'web/empty.js'] });
  assert.deepEqual(store.itemFiles(store.getItem(board, id)), ['web/page.js', 'web/page.test.js', 'web/empty.js']);
});

test('related items: verified work that touched the same files, the most shared first [N21]', () => {
  const build = (title, files) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    claimAs(id, 'web-1', 'web');
    submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't', files });
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
  const strong = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Design the cache', route: 'strong' });
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
    submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 't' });
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
  assert.throws(() => claimAs(nav, 'web-1', 'web'), new RegExp(`ONE_CLAIM.*you already hold #${header}`), 'legacy calls keep the old rule');
  assert.equal(store.claim(board, nav, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true }).renewed, false);
  submitFixture(board, page, { agentId: 'web-1', commit: SHA_B, tree: 't2' });
  assert.equal(store.getItem(board, page).item_status, 'submitted');
  const other = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Other nav' });
  claimAs(other, 'web-2', 'web');
  assert.throws(() => claimAs(aside, 'web-2', 'web'), /ONE_CLAIM/, 'the historical rule remains for old moves');
  assert.equal(store.claim(board, aside, { agentId: 'web-2', lane: 'web', leaseMs: 2 * HOUR, freeze, itemFolder: true }).renewed, false);
});

test('[O3] declared families travel through native snapshots; unknown registration remains allowed and fresh review refuses', async (t) => {
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
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
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
  const initialBoard = await runMain(repo, ['status', '--json']);
  assert.equal(initialBoard.code, 0, initialBoard.stderr || initialBoard.stdout);

  const savedWorktreeModel = process.env.PULLBOARD_MODEL;
  delete process.env.PULLBOARD_MODEL;
  let missingWorktreeModel;
  try { missingWorktreeModel = await runMain(repo, ['worktree', 'web', '--json']); }
  finally { if (savedWorktreeModel === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = savedWorktreeModel; }
  assert.equal(missingWorktreeModel.code, 1);
  assert.equal(JSON.parse(missingWorktreeModel.stdout).error.code, 'MODEL_REQUIRED', 'worktree without a flag or model environment refuses');
  const made = await runMain(repo, ['worktree', 'web', '--family', 'Family Alpha', '--route', 'strong', '--json']);
  assert.equal(made.code, 0, made.stderr || made.stdout);
  const worktree = JSON.parse(made.stdout);
  assertJsonShape(worktree, 'worktree');
  assert.equal(worktree.agent, 'web-1', 'the model never changes the stable id');
  assert.equal(worktree.model, 'Test Model');
  assert.equal(worktree.displayName, 'web-1 (Test Model)');
  assert.match(worktree.prompt, /Model: 'Test Model'\./);
  assert.match(worktree.prompt, /pass --model 'Test Model' or set PULLBOARD_MODEL='Test Model'/);
  const builderPath = worktree.path;
  const reviewerPath = join(directory, 'reviewer');
  git(repo, 'worktree', 'add', '-q', '-b', 'review/one', reviewerPath, 'main');
  const reviewerRoot = git(reviewerPath, 'rev-parse', '--show-toplevel');
  const joined = await runMain(reviewerRoot, ['join', 'review', '--family', 'Family Beta', '--route', 'strong', '--json']);
  assert.equal(joined.code, 0, joined.stderr || joined.stdout);
  const joinResult = JSON.parse(joined.stdout);
  assertJsonShape(joinResult, 'join');
  assert.equal(joinResult.model, 'Test Model');
  assert.equal(joinResult.displayName, 'review-1 (Test Model)');
  const noFamilyPath = join(directory, 'no-family');
  git(repo, 'worktree', 'add', '-q', '-b', 'web/two', noFamilyPath, 'main');
  const noFamilyRoot = git(noFamilyPath, 'rev-parse', '--show-toplevel');
  const savedModel = process.env.PULLBOARD_MODEL;
  delete process.env.PULLBOARD_MODEL;
  let missingModel;
  try { missingModel = await runMain(noFamilyRoot, ['join', 'web', '--json']); }
  finally { if (savedModel === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = savedModel; }
  assert.equal(missingModel.code, 1);
  assert.equal(JSON.parse(missingModel.stdout).error.code, 'MODEL_REQUIRED', 'join without a flag or model environment refuses');
  const joinedWithout = await runMain(noFamilyRoot, ['join', 'web', '--route', 'strong']);
  assert.equal(joinedWithout.code, 0, joinedWithout.stderr || joinedWithout.stdout);

  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const persistent = openBoard(file);
  t.after(() => store.closeBoard(persistent));
  const initialEvents = store.events(persistent);
  const coordinatorJoin = initialEvents.find(event => event.event_kind === 'join' && event.event_by === 'coordinator');
  const baselineEvents = initialEvents.filter(event => event.event_kind === 'spec_approval_baseline');
  const builderJoin = initialEvents.find(event => event.event_kind === 'join' && event.event_by === 'web-1');
  assert.equal(baselineEvents.length, 1, 'first worktree setup records the compatibility baseline exactly once');
  assert.ok(coordinatorJoin.event_id < baselineEvents[0].event_id && baselineEvents[0].event_id < builderJoin.event_id,
    'a cold local main establishes its coordinator and existing approvals before registering the worktree');
  assert.deepEqual(store.specApprovalBaseline(persistent).rows.map(row => row.id), ['G1'],
    'later lane joins retain the original approved source row');
  assert.equal(store.agentAt(persistent, builderPath).agent_family, 'Family Alpha');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta');
  assert.equal(store.agentAt(persistent, noFamilyRoot).agent_family, null);
  assert.equal(store.agentAt(persistent, noFamilyRoot).agent_model, 'Test Model');
  const apiState = projectState(repo);
  assert.equal(apiState.agents.find((agent) => agent.agent_id === 'web-1').agent_model, 'Test Model');
  // CLI seats use Git's physical root even when the fixture directory names a /tmp alias.
  const coordinatorRoot = git(repo, 'rev-parse', '--show-toplevel');
  assert.equal(store.agentAt(persistent, coordinatorRoot).agent_id, 'coordinator');
  store.register(persistent, { lane: 'coordinator', path: coordinatorRoot });
  const stateWithCoordinator = projectState(repo);
  assert.equal(stateWithCoordinator.agents.find((agent) => agent.agent_id === 'coordinator').agent_model, null);
  assert.equal(store.agentAt(persistent, coordinatorRoot).agent_family, null, 'the core supplies no family for itself');
  store.register(persistent, { lane: 'coordinator', path: coordinatorRoot, family: 'Family Coordinator' });
  const coordinatorResume = await runMain(repo, ['resume']);
  assert.match(coordinatorResume.stdout, /resume: coordinator \(unknown\) \[family Family Coordinator\], coordinator lane/);
  const coordinatorJson = await runMain(repo, ['resume', '--json']);
  assert.equal(JSON.parse(coordinatorJson.stdout).me.family, 'Family Coordinator');

  const id = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'Family feature' });
  store.claim(persistent, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  submitFixture(persistent, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree-a' });
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
  assert.match(shownText.stdout, /submitted by web-1 \(Test Model\) \[family Family Alpha\]/);
  assert.match(shownText.stdout, /ACCEPT CRITERION_MET by review-1 \(Test Model\) \[family Family Beta\]/);

  const redeclared = await runMain(reviewerRoot, ['join', 'review', '--family', 'Family Gamma', '--json']);
  assert.equal(redeclared.code, 1, redeclared.stderr || redeclared.stdout);
  assert.equal(JSON.parse(redeclared.stdout).error.code, 'FAMILY_DECLARED');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_id, 'review-1', 'a refused declaration keeps the existing agent id');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta', 'a refused declaration preserves the immutable family');
  assert.deepEqual(store.verdictsFor(persistent, id), [recorded], 'a refused declaration preserves the complete old verdict');
  assert.equal(store.verdictsFor(persistent, id)[0].verdict_verifier_family, 'Family Beta', 'a refused declaration leaves the old verdict family unchanged');
  const sameFamily = await runMain(reviewerRoot, ['join', 'review', '--family', 'Family Beta', '--route', 'strong', '--json']);
  assert.equal(sameFamily.code, 0, sameFamily.stderr || sameFamily.stdout);
  assert.equal(JSON.parse(sameFamily.stdout).agent, 'review-1', 'the same family rejoins with the stable agent id');
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta');
  const rejoined = await runMain(reviewerRoot, ['join', 'review', '--json']);
  assert.equal(rejoined.code, 0, rejoined.stderr || rejoined.stdout);
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta', 'omitting --family preserves the declaration');
  const historicalShow = await runMain(repo, ['show', String(id)]);
  assert.match(historicalShow.stdout, /ACCEPT CRITERION_MET by review-1 \(Test Model\) \[family Family Beta\]/);

  const resumed = await runMain(builderPath, ['resume']);
  assert.match(resumed.stdout, /resume: web-1 \(Test Model\) \[family Family Alpha\], web lane/);
  const resumedJson = await runMain(builderPath, ['resume', '--json']);
  assert.equal(resumedJson.code, 0, resumedJson.stderr || resumedJson.stdout);
  const resumedShape = JSON.parse(resumedJson.stdout);
  assertJsonShape(resumedShape, 'resume');
  assert.equal(resumedShape.me.family, 'Family Alpha');

  const unverified = store.addItem(persistent, { by: 'coordinator', lane: 'review', title: 'No-family verdict' });
  store.claim(persistent, unverified, { agentId: 'review-1', lane: 'review', leaseMs: 2 * HOUR, freeze: familyFreeze });
  submitFixture(persistent, unverified, { agentId: 'review-1', commit: SHA_B, tree: 'tree-b' });
  verifyLegacyUnknownFamily(persistent, unverified, {
    agentId: 'web-2', decision: 'ACCEPT', note: 'checked without a family declaration',
    head: SHA_B, digest: 'digest:family', policy: 'any',
  });
  const [unattributed] = store.verdictsFor(persistent, unverified);
  assert.equal(unattributed.verdict_verifier_family, null);

  const unclaimed = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'No-family submission' });
  store.claim(persistent, unclaimed, { agentId: 'web-2', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  submitFixture(persistent, unclaimed, { agentId: 'web-2', commit: SHA_A, tree: 'tree-c' });
  assert.equal(store.getItem(persistent, unclaimed).item_builder_family, null);

  const differentFamily = store.addItem(persistent, { by: 'coordinator', lane: 'web', title: 'CLI family review' });
  store.claim(persistent, differentFamily, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: familyFreeze });
  submitFixture(persistent, differentFamily, { agentId: 'web-1', commit: SHA_A, tree: 'tree-d' });
  assert.equal(store.agentAt(persistent, reviewerRoot).agent_family, 'Family Beta');
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

  const prefixConfig = JSON.parse(policyConfig);
  prefixConfig.agents = { names: 'prefix' };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(prefixConfig, null, 2));
  git(repo, 'add', 'pullboard.json');
  git(repo, 'commit', '-q', '-m', 'docs: configure prefix agent names');
  const prefixMade = await runMain(repo, ['worktree', 'web', '--model', 'Claude Sonnet', '--json']);
  assert.equal(prefixMade.code, 0, prefixMade.stderr || prefixMade.stdout);
  const prefixResult = JSON.parse(prefixMade.stdout);
  assert.equal(prefixResult.agent, 'web-3');
  assert.equal(prefixResult.model, 'Claude Sonnet');
  assert.equal(prefixResult.displayName, 'claude-sonnet-web-3');
  const quotedModel = await runMain(repo, ['worktree', 'web', '--model', 'Model " $x', '--json']);
  assert.equal(quotedModel.code, 0, quotedModel.stderr || quotedModel.stdout);
  assert.match(JSON.parse(quotedModel.stdout).prompt, /Model: 'Model " \$x'\./);
  assert.match(JSON.parse(quotedModel.stdout).prompt, /pass --model 'Model " \$x'/);
});

test('[O2,O3,H16] historical family policy controls review order and refuses unknown or matching families', () => {
  // Preserve the original off/prefer/require control under its predecessor execution origin.
  board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE - 1;
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'Family Alpha' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: 'Family Beta' });
  store.register(board, { lane: 'api', path: '/repo-api-1', family: 'Family Beta' });
  const submitAs = (agentId, title) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    store.claim(board, id, { agentId, lane: 'web', leaseMs: HOUR, freeze: () => ({ text: title, digest: 'digest:Page' }) });
    submitFixture(board, id, { agentId, commit: SHA_A, tree: `tree-${title}` });
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

