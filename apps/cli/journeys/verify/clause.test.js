/** @pullboard-test-input source-tree */
/** Repeated rejects identify the frozen requirement that needs clarification [V6,R2,B30,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import { REJECT_CLAUSE_ENGINE } from '../../../../packages/state/light.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const CRITERION = 'The page renders its title. The page renders its footer.';
const TITLE_CLAUSE = 'The page renders its title.';

/** Create a real SQLite board with independent builder and reviewer seats. */
function fixture(t, criterion = CRITERION) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/reject-clause/main' });
  const builder = store.register(board, { lane: 'web', path: '/reject-clause/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/reject-clause/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Render the page',
    criterion, check: 'true', route: 'mid',
    brief: 'Files: web/page.html\nTest: assert the rendered title and footer.' });
  const freeze = () => ({ text: JSON.stringify({ criterion, rows: [],
    policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'reject-clause-bar-v1' });
  /** Submit a different synthetic head without claiming that a fixture ran a gate. */
  function submit(character) {
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
    const head = character.repeat(40);
    submitFixture(board, id, { agentId: builder, commit: head, tree: character.repeat(40) });
    return head;
  }
  /** Reject one actual submitted head with the explicit quoted requirement. */
  function reject(head, clause = TITLE_CLAUSE) {
    return store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH',
      note: 'The rendered output omits the title.', clause, head,
      digest: store.getItem(board, id).item_frozen_digest, policy: 'any' });
  }
  return { board, builder, reviewer, id, freeze, submit, reject };
}

test('a second reject on the same clause routes the bar to be sharpened [V6,R2,B30,H16]', t => {
  const { board, builder, id, freeze, submit, reject } = fixture(t);
  reject(submit('a'));
  assert.equal(store.getItem(board, id).item_status, 'open', 'the first rejection permits ordinary rework');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  reject(submit('b'));
  const repeated = store.getItem(board, id);
  assert.match(repeated.item_hold_reason ?? '', /bar.*sharpen/iu,
    'a second rejection of one frozen clause holds the item for a sharper bar');
  assert.throws(() => store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze }),
    { code: 'ITEM_HELD' }, 'the unchanged bar cannot start a third build round');
  const notices = store.events(board, { itemId: id }).filter(event => event.event_kind === 'bar-sharpen');
  assert.equal(notices.length, 1, 'the repeated clause produces one durable sharpening notice');
  assert.equal(JSON.parse(notices[0].event_detail).clause, TITLE_CLAUSE);
});


test('a repeated long clause still issues its sharpening notice within the shout limit [V6,R2,H16]', t => {
  const longClause = `The page renders ${'every listed section heading in order, '.repeat(12)}and its title.`;
  const { board, id, submit, reject } = fixture(t, `${longClause} The page renders its footer.`);
  reject(submit('a'), longClause);
  reject(submit('b'), longClause);
  assert.match(store.getItem(board, id).item_hold_reason ?? '', /bar.*sharpen/iu, 'the second reject still holds the item');
  const notice = board.db.prepare("SELECT shout_text FROM shout WHERE shout_text LIKE '%sharper bar%'").all();
  assert.equal(notice.length, 1, 'the sharpening notice is sent, not rolled back');
  assert.ok(notice[0].shout_text.length <= 400, `the notice fits a shout: ${notice[0].shout_text.length}`);
  assert.match(notice[0].shout_text, /\+\d+ characters; pullboard show \d+\)/u, 'the cut names what it elided');
});

test('rejects require a real frozen clause before appending any verdict [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  const head = submit('a');
  const before = store.events(board);
  for (const malformed of ['', '   ', true, 7, {}, []]) {
    assert.throws(() => reject(head, malformed), { code: 'BAR_CLAUSE_REQUIRED' });
  }
  assert.throws(() => reject(head, 'x'.repeat(4097)), { code: 'BAR_CLAUSE_UNKNOWN' });
  assert.throws(() => reject(head, 'A requirement the bar never named.'), { code: 'BAR_CLAUSE_UNKNOWN' });
  assert.deepEqual(store.events(board), before, 'refused clauses produce no verdict, event, or hold');
  assert.equal(store.getItem(board, id).item_status, 'submitted');
});

test('different clauses do not combine into a repeated-clause hold [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  reject(submit('a'));
  reject(submit('b'), 'The page renders its footer.');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  assert.equal(store.events(board, { itemId: id }).filter(event => event.event_kind === 'bar-sharpen').length, 0);
});

test('the board can send a repeated-clause sharpening request to the person [V6,B30,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  store.setLineSetting(board, { agentId: 'coordinator', key: 'bar.sharpenToPerson', value: true,
    reason: 'The owner reviews bar ambiguities.', window: { repeatedRejects: 2 } });
  reject(submit('a'));
  reject(submit('b'));
  const event = store.events(board, { itemId: id }).find(entry => entry.event_kind === 'bar-sharpen');
  assert.equal(JSON.parse(event.event_detail).to, 'person');
  const request = board.db.prepare("SELECT * FROM shout WHERE shout_to='person' AND shout_decision=1").all();
  assert.equal(request.length, 1, 'the person receives an actual pending decision, not a forged answer');
  assert.match(request[0].shout_text, /sharper bar/u);
});

test('clause quotes normalize whitespace and remain visible on immutable verdicts [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  const first = reject(submit('a'), '  The page\n renders its title.  ');
  assert.equal(first.clause, TITLE_CLAUSE);
  assert.equal(first.held, false);
  const second = reject(submit('b'));
  assert.equal(second.held, true);
  assert.deepEqual(store.verdictsFor(board, id).map(verdict => verdict.clause), [TITLE_CLAUSE, TITLE_CLAUSE]);
});

test('different quotations of the same requirement cannot restart the rejection count [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  reject(submit('a'), 'renders its title.');
  reject(submit('b'), TITLE_CLAUSE);
  assert.ok(store.getItem(board, id).item_hold_reason);
  assert.deepEqual(store.verdictsFor(board, id).map(verdict => verdict.clause), ['renders its title.', TITLE_CLAUSE],
    'each immutable verdict retains what its reviewer actually quoted');
});

test('an ambiguous quote cannot name two different frozen requirements [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  const head = submit('a');
  const before = store.events(board);
  assert.throws(() => reject(head, 'The page renders its'), { code: 'BAR_CLAUSE_UNKNOWN' });
  assert.deepEqual(store.events(board), before);
  assert.equal(store.getItem(board, id).item_status, 'submitted');
});

test('an unrelated policy commit does not reset repeated-clause history [V6,R2,H16]', t => {
  const { board, id, freeze, submit, reject } = fixture(t);
  store.refreeze(board, id, { agentId: 'coordinator', freeze: () => ({
    text: JSON.stringify({ criterion: CRITERION, rows: [], policy: { commit: 'a'.repeat(40) } }), digest: 'policy-a' }) });
  reject(submit('a'));
  store.refreeze(board, id, { agentId: 'coordinator', freeze: () => ({
    text: JSON.stringify({ criterion: CRITERION, rows: [], policy: { commit: 'b'.repeat(40) } }), digest: 'policy-b' }) });
  reject(submit('b'));
  assert.ok(store.getItem(board, id).item_hold_reason, 'ordinary trunk movement cannot restart the same bar cycle');
  assert.notEqual(freeze().digest, store.getItem(board, id).item_frozen_digest);
});

test('a genuinely refrozen criterion starts a separate clarification cycle [V6,R2,H16]', t => {
  const { board, id, submit, reject } = fixture(t);
  reject(submit('a'));
  const revised = 'The page renders its title. Its footer contains an accessible link.';
  store.editItem(board, id, { agentId: 'coordinator', criterion: revised, reason: 'Specify the footer requirement.' });
  store.refreeze(board, id, { agentId: 'coordinator', freeze: () => ({
    text: JSON.stringify({ criterion: revised, rows: [] }), digest: 'revised-criterion' }) });
  reject(submit('b'));
  assert.equal(store.getItem(board, id).item_hold_reason, null);
});

test('clause counts remain separate for different items on the same board [V6,R2,H16]', t => {
  const { board, builder, reviewer, id, freeze, submit, reject } = fixture(t);
  reject(submit('a'));
  const other = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Another page', criterion: CRITERION });
  store.claim(board, other, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, other, { agentId: builder, commit: 'c'.repeat(40), tree: 'c'.repeat(40) });
  store.verify(board, other, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: TITLE_CLAUSE, note: 'This other page lacks its title.', head: 'c'.repeat(40), digest: freeze().digest, policy: 'any' });
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  assert.equal(store.getItem(board, other).item_hold_reason, null);
});

test('new clause payloads are engine-fenced and recorded replay never duplicates a hold or notice [V6,R2,H16]', t => {
  const { board, reviewer, id, freeze, submit } = fixture(t);
  /** Seal one current rejection with its exact submitted head and quoted requirement. */
  const moveFor = (head, moveId) => prepareEngineMove(board, 'verify', [id, { agentId: reviewer,
    decision: 'REJECT', reason: 'TEST_FAILURE', note: 'The title is missing.', clause: TITLE_CLAUSE,
    head, digest: freeze().digest, policy: 'any' }], { id: moveId, actor: reviewer });
  const first = moveFor(submit('a'), 'first-clause-reject');
  const original = exportBoard(board);
  assert.throws(() => applyEngineMove(board, { ...first, engine: REJECT_CLAUSE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-25T00:00:00Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), original, 'an impossible older tag changes no row or replay cursor');
  assert.equal(applyEngineMove(board, first, { sequence: 1, at: '2026-10-25T00:00:00Z' }).error, undefined);
  const second = moveFor(submit('b'), 'second-clause-reject');
  const receipt = { sequence: 2, at: '2026-10-25T00:01:00Z' };
  const result = applyEngineMove(board, second, receipt);
  assert.equal(result.error, undefined);
  assert.equal(result.result.held, true);
  const recorded = exportBoard(board);
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, recorded);
  for (const copy of [board, replica]) {
    assert.deepEqual(applyEngineMove(copy, second, receipt), result);
    assert.deepEqual(exportBoard(copy), recorded, 'an exact stored acknowledgment is replayed without another side effect');
  }
});

test('historical clause-free rejections retain their old recorded meaning [V6,R2,H16]', t => {
  const { board, reviewer, id, freeze, submit } = fixture(t);
  const head = submit('a');
  const historical = { version: 1, engine: REJECT_CLAUSE_ENGINE - 1, id: 'historical-clause-free',
    operation: 'verify', actor: reviewer, args: [id, { agentId: reviewer, decision: 'REJECT',
      reason: 'TEST_FAILURE', note: 'Historical title failure.', head, digest: freeze().digest, policy: 'any' }] };
  const outcome = applyEngineMove(board, historical, { sequence: 1, at: '2026-10-25T00:00:00Z' });
  assert.equal(outcome.error, undefined);
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(store.verdictsFor(board, id)[0].clause, undefined);
  assert.equal(store.getItem(board, id).item_hold_reason, null);
});

test('the person-routing setting refuses older tags and non-coordinator changes [B30,R2,H16]', t => {
  const { board, builder } = fixture(t);
  const options = { agentId: 'coordinator', key: 'bar.sharpenToPerson', value: true,
    reason: 'Clarification belongs to the owner.', window: { repeatedRejects: 2 } };
  const before = exportBoard(board);
  assert.throws(() => store.setLineSetting(board, { ...options, agentId: builder }), { code: 'COORDINATOR_ONLY' });
  const move = prepareEngineMove(board, 'setLineSetting', [options], { id: 'clause-person-policy', actor: 'coordinator' });
  assert.throws(() => applyEngineMove(board, { ...move, engine: REJECT_CLAUSE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-25T00:00:00Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), before);
});

test('public CLI and API reject calls preserve the explicit frozen clause [V6,A2,R2,H16]', t => {
  const helpers = createE2eHelpers();
  let board;
  t.after(() => { if (board) store.closeBoard(board); helpers.cleanup(); });
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'A quoted public rejection', '--criterion', CRITERION,
    '--specs', 'G1', '--check', 'test -f web/page.html', '--route', 'strong',
    '--brief', 'Files: web/page.html\nTest: assert the rendered title and footer.', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const committed = helpers.commitFile(box, box.web, 'web/page.html', '<main>Missing the title</main>', 'feat(web): render a page [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  // @pullboard-board-file persistence: separate CLI reviewer commands read and append this exact private board file.
  board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  submitFixture(board, id, { agentId: 'web-1', commit: head, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') });
  const reviewer = join(box.dir, 'clause-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  box.env.CODEX_THREAD_ID = 'independent-clause-review-fixture';
  assert.equal(fixtureJoin(box.run, reviewer, 'api', '--route', 'strong').code, 0);
  const reserved = box.run(reviewer, 'next', '--verify', String(id), '--json');
  assert.equal(reserved.code, 0, reserved.out || reserved.err);
  assert.equal(JSON.parse(reserved.out).item.item_id, id);
  const missing = box.run(reviewer, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--note', 'The title is missing.', '--json');
  assert.equal(missing.code, 1, missing.err + missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'BAR_CLAUSE_REQUIRED');
  const argv = moveArgs({ verb: 'reject', item: id,
    args: { reason: 'TEST_FAILURE', note: 'The title is missing.', clause: TITLE_CLAUSE } });
  assert.ok(argv.includes(`--clause=${TITLE_CLAUSE}`), 'the API transports one literal caller-supplied argument');
  const rejected = box.run(reviewer, ...argv);
  assert.equal(rejected.code, 0, rejected.err + rejected.out);
  assert.equal(JSON.parse(rejected.out).clause, TITLE_CLAUSE);
  assert.equal(store.verdictsFor(board, id).at(-1).clause, TITLE_CLAUSE);
  assert.throws(() => moveArgs({ verb: 'reject', item: id,
    args: { reason: 'TEST_FAILURE', note: 'why', clause: true } }), { code: 'BAD_REQUEST' });
});

/** Freeze the actual criterion independently of any unrecovered clause implementation. */
function freeze() {
  return { text: JSON.stringify({ criterion: CRITERION, rows: [],
    policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }),
  digest: 'reject-clause-before-v1' };
}

test('rejects require a frozen clause before any verdict mutation [V6,R2,H16]', t => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/reject-clause/main' });
  const builder = store.register(board, { lane: 'web', path: '/reject-clause/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/reject-clause/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Render the page',
    criterion: CRITERION, check: 'true', route: 'mid',
    brief: 'Files: web/page.html\nTest: assert the rendered title and footer.' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  const head = 'a'.repeat(40);
  // This is board-state setup, not a claim that a synthetic source tree ran a gate.
  submitFixture(board, id, { agentId: builder, commit: head, tree: head });
  store.reserveReview(board, id, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_review_by, reviewer);
  assert.equal(store.verdictsFor(board, id).length, 0);
  const before = store.events(board);
  assert.throws(() => store.verify(board, id, { agentId: reviewer, decision: 'REJECT',
    reason: 'BEHAVIOR_MISMATCH', note: 'The rendered output omits the title.',
    head, digest: store.getItem(board, id).item_frozen_digest, policy: 'any' }),
  { code: 'BAR_CLAUSE_REQUIRED' }, 'a native rejection without a frozen clause must refuse');
  assert.deepEqual(store.events(board), before, 'refusal appends no verdict event or hold');
  assert.equal(store.verdictsFor(board, id).length, 0);
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  assert.equal(store.getItem(board, id).item_review_by, reviewer);
});
