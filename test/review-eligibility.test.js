/** Private board-state fixtures exercise independence; synthetic commits and events are not gate proof [V4,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { reviewEligibility } from '../src/review-eligibility.js';
import { itemReviewPolicy } from '../src/review-independence.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../src/review-independence-engine.js';
import { workQueue } from '../src/queue.js';
import { exportBoard } from '../src/exchange.js';
import { importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runCliInProcess } from './cli-in-process-fixture.js';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-bar' });

/** Declare every vendor and persisted parent explicitly; no model label supplies an inferred family. */
function fixture(t, { historical = false } = {}) {
  const board = fixtureBoard(t);
  if (historical) board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE - 1;
  const join = (id, family, parent) => store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
    family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
  join('coordinator', 'human', 'e');
  join('core-1', 'codex', 'a');
  join('core-2', 'claude', 'b');
  join('core-3', 'claude', 'b');
  join('core-4', 'codex', 'c');
  join('core-5', 'claude', 'd');
  /** Add an item without claiming that any fixture process created its synthetic commit. */
  const add = options => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Independence fixture', ...options });
  /** Record one submit-backed synthetic commit through the production board guards. */
  const submit = (id, builder = 'core-1') => {
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: LEASE, freeze });
    submitFixture(board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
    return store.getItem(board, id);
  };
  const reserve = (id, agentId) => store.reserveReview(board, id, { agentId, leaseMs: LEASE, policy: 'any' });
  return { board, add, submit, reserve };
}

test("a helper's posted fact does not make a seat ineligible [V4,B26]", t => {
  const f = fixture(t), id = f.add();
  store.claim(f.board, id, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'Diagnostic only; no submitted commit.' });
  store.release(f.board, id, 'core-2');
  const item = f.submit(id);
  assert.deepEqual(reviewEligibility(f.board, item).eligible, ['coordinator', 'core-2', 'core-3', 'core-5']);
  assert.equal(f.reserve(id, 'core-3').item_review_by, 'core-3', 'a released claim without a commit is not Standard authorship');
});

test('a strict item refuses any seat that touched it [V4,B26]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'A native diagnostic fact counts under Strict.' });
  const item = f.submit(id);
  const before = store.events(f.board);
  assert.throws(() => f.reserve(id, 'core-3'), e => e.code === 'STRICT_REVIEW_TOUCHED' && /fact/u.test(e.message));
  assert.deepEqual(store.events(f.board), before, 'a refused reservation appends nothing');
  assert.equal(reviewEligibility(f.board, item).tier, 'strict');
  assert.deepEqual(reviewEligibility(f.board, item).eligible, ['core-5']);
});

test('next offers a review only to an eligible seat [V4,B26]', t => {
  const f = fixture(t), same = f.add(), eligible = f.add();
  f.submit(same, 'core-2');
  f.submit(eligible, 'core-1');
  const offered = store.reserveNextReview(f.board, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any' });
  assert.equal(offered.item.item_id, eligible, 'the older same-vendor item is never offered');
  const queue = workQueue(f.board, 'core-5');
  const ids = [...queue.releases.flatMap(r => r.items), ...queue.unreleased].map(item => item.id);
  assert.equal(ids.includes(same), false, 'the work queue uses the same vendor rule');
  assert.equal(ids.includes(eligible), true);
});

test('Strict permits its own reservation and verdict but an ordinary check still counts as a write [V4,B26]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  const item = f.submit(id);
  f.reserve(id, 'core-5');
  // Explicitly synthetic history tests the protocol distinction; this is not a native gate receipt.
  store.logEvent(f.board, 'core-5', 'proof-run', id, { receipt: { kind: 'verdict' } });
  assert.equal(store.verify(f.board, id, { agentId: 'core-5', decision: 'ACCEPT', note: 'Private board-state protocol fixture only.',
    head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', check: 'none' }).decision, 'ACCEPT');
  const other = f.add({ sensitive: true });
  f.submit(other);
  store.logEvent(f.board, 'core-5', 'proof-run', other, { receipt: { kind: 'check' } });
  assert.throws(() => f.reserve(other, 'core-5'), e => e.code === 'STRICT_REVIEW_TOUCHED');
});

test('unknown or matching vendor families refuse fresh review and a required family selects Strict [V4,B26]', t => {
  const f = fixture(t), id = f.add({ reviewFamily: 'claude' });
  f.submit(id);
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/unknown', model: 'A model label is not a vendor declaration' });
  store.register(f.board, { id: 'core-7', lane: 'core', path: '/fixture/other', family: 'other' });
  for (const actor of ['core-6', 'core-4', 'core-7']) assert.throws(() => f.reserve(id, actor), e => e.code === 'O2_FAMILY_MATCH');
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  assert.equal(f.reserve(id, 'core-5').item_review_by, 'core-5');
});

test('historical sealed review rules retain claim authors and optional unknown families [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
  store.claim(f.board, id, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze });
  store.release(f.board, id, 'core-2');
  f.submit(id);
  assert.throws(() => f.reserve(id, 'core-2'), e => e.code === 'SELF_VERIFY');
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/legacy' });
  assert.equal(f.reserve(id, 'core-6').item_review_by, 'core-6');
  assert.throws(() => f.add({ sensitive: true }), e => e.code === 'ENGINE_VERSION');
});

test('native snapshots retain Strict policy and policy edits cannot weaken a live review [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true, reviewFamily: 'claude' });
  f.submit(id);
  assert.throws(() => store.editItem(f.board, id, { agentId: 'coordinator', sensitive: false, reviewFamily: null }), e => e.code === 'HELD');
  const replica = fixtureBoard(t);
  importBoard(replica, exportBoard(f.board));
  assert.deepEqual(itemReviewPolicy(replica, id), itemReviewPolicy(f.board, id));
  assert.deepEqual(reviewEligibility(replica, store.getItem(replica, id)).eligible,
    reviewEligibility(f.board, store.getItem(f.board, id)).eligible);
});


test('CLI add and edit flags persist Strict policy and show projects its tier [V4,B26,P4]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  /** Exercise the production parser and ordered writer against an isolated Git-backed board. */
  const run = argv => runCliInProcess(argv, { cwd: box.repo, env: box.env });
  const added = await run(['add', 'web', 'Strict CLI contract', '--sensitive', '--json']);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const id = JSON.parse(added.stdout).item.item_id;
  const edited = await run(['edit', String(id), '--review-family', 'claude', '--json']);
  assert.equal(edited.status, 0, edited.stderr || edited.stdout);
  const shown = await run(['show', String(id), '--json']);
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  assert.deepEqual(JSON.parse(shown.stdout).reviewEligibility,
    { tier: 'strict', requiredFamily: 'claude', ready: false, eligible: [], ineligible: [] });
  const text = await run(['show', String(id)]);
  assert.equal(text.status, 0, text.stderr || text.stdout);
  assert.match(text.stdout, /review tier: strict; required family claude/u);
  assert.match(text.stdout, /eligible reviewers: not submitted/u);
});
