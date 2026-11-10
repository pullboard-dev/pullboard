/** @pullboard-test-input source-tree */
import { VENDOR_FAMILY_ENGINE } from '../../../../../packages/state/light.js';
import { canonicalFamily } from '../../../../../packages/verify/index.js';
import { STRICT_COMPOSITION_ENGINE } from '../../../../../packages/state/light.js';
import * as queueStore from '../../../../../packages/store/index.js';
import { roadmap } from '../../../../../packages/store/index.js';
import { eligibilityProblem as queueEligibility } from '../../../../../packages/verify/index.js';
/** Private board-state fixtures exercise independence; synthetic commits and events are not gate proof [V4,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../../packages/state/light.js';
import { reviewEligibility } from '../../../../../packages/verify/index.js';
import { itemReviewPolicy } from '../../../../../packages/verify/index.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../../packages/state/light.js';
import { workQueue } from '../../../../../packages/items/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { minimumMoveEngine } from '../../../../../packages/moves/index.js';
import { familyIndex } from '../../../../../packages/verify/index.js';
import { FAMILY_ALIAS_ENGINE } from '../../../../../packages/state/light.js';
import { FAMILY_DECLARE_ENGINE } from '../../../../../packages/state/light.js';
import { seatFamily } from '../../../../../packages/items/index.js';
import { parentSessionDigest as parentSessionDigestOf } from '../../../../../packages/items/index.js';
import { familyName } from '../../../../../packages/verify/index.js';
import { withOpenedBoard } from '../../../index.js';
import { readFileSync } from 'node:fs';
import { REPOSITORY } from '../../../tests/fixtures/source.js';
import { movedSourceFiles } from '../../../tests/fixtures/source.js';
import { sourceFiles } from '../../../tests/fixtures/source.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-bar' });

/** Declare every vendor and persisted parent explicitly; no model label supplies an inferred family. */
function fixture(t, { historical = false, requireFamilies = true, engine } = {}) {
  const board = fixtureBoard(t);
  if (engine !== undefined) board.executionEngineVersion = engine;
  else if (historical) board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE - 1;
  const join = (id, family, parent) => store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
    family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
  join('coordinator', 'human', 'e');
  join('core-1', 'codex', 'a');
  join('core-2', 'claude', 'b');
  join('core-3', 'claude', 'b');
  join('core-4', 'codex', 'c');
  join('core-5', 'claude', 'd');
  if (!historical) store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: requireFamilies,
    reason: 'Private review eligibility fixture explicitly selects its vendor policy.', window: { syntheticSeats: 6 } });
  /** Add an item without claiming that any fixture process created its synthetic commit. */
  const add = options => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Independence fixture', ...options });
  /** Record one submit-backed synthetic commit through the production board guards. */
  const submit = (id, builder = 'core-1') => {
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: LEASE, freeze });
    submitFixture(board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
    return store.getItem(board, id);
  };
  const reserve = (id, agentId) => store.reserveReview(board, id, { agentId, leaseMs: LEASE, policy: 'any', familyPolicy: historical ? 'off' : 'require' });
  return { board, add, submit, reserve };
}

test("a helper's posted fact does not make a seat ineligible [V4,B26]", t => {
  const f = fixture(t), id = f.add();
  store.claim(f.board, id, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'Diagnostic only; no submitted commit.' });
  store.release(f.board, id, 'core-2', 'Diagnostic work is finished without a submitted commit.', 'OTHER');
  const item = f.submit(id);
  assert.deepEqual(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible, ['coordinator', 'core-2', 'core-3', 'core-5']);
  assert.equal(f.reserve(id, 'core-3').item_review_by, 'core-3', 'a released claim without a commit is not Standard authorship');
});

test('Pre-composition: one eligibility projection reads shared history once and the next sees new facts [C7,V4,B26]', t => {
  const f = fixture(t); f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1; const id = f.add({ sensitive: true }), item = f.submit(id);
  const original = f.board.db;
  let historyReads = 0;
  const observed = { ...f.board, db: {
    /** Forward real transaction control without changing persistent fixture rows. */
    exec(sql) { return original.exec(sql); },
    /** Count actual history reads while returning the real SQLite statement results. */
    prepare(sql) {
      const statement = original.prepare(sql);
      return {
        /** Preserve the exact native single-row result. */
        get(...args) { return statement.get(...args); },
        /** Count the shared submission query, never replace or cache its result here. */
        all(...args) {
          if (sql.includes("SELECT event_by,event_detail FROM event") && sql.includes("event_kind='submit'")) historyReads++;
          return statement.all(...args);
        },
      };
    },
  } };
  const before = exportBoard(f.board);
  assert.deepEqual(reviewEligibility(observed, item, { familyPolicy: 'require' }).eligible, ['core-2', 'core-3', 'core-5']);
  t.diagnostic(`submission history reads for one projection: ${historyReads}`);
  assert.equal(historyReads, 1, 'every candidate shares the same item submission history');
  assert.deepEqual(exportBoard(f.board), before, 'a projection changes no persistent row');
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'New native fact between separate projections.' });
  const changed = exportBoard(f.board);
  historyReads = 0;
  assert.deepEqual(reviewEligibility(observed, item, { familyPolicy: 'require' }).eligible, ['core-5']);
  assert.equal(historyReads, 1, 'the next projection owns a fresh read');
  assert.deepEqual(exportBoard(f.board), changed, 'freshness needs no persistent cache');
});

test('Pre-composition: a strict item refuses any seat that touched it [V4,B26]', t => {
  const f = fixture(t); f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1; const id = f.add({ sensitive: true });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'A native diagnostic fact counts under Strict.' });
  const item = f.submit(id);
  const before = store.events(f.board);
  assert.throws(() => f.reserve(id, 'core-3'), e => e.code === 'STRICT_REVIEW_TOUCHED' && /fact/u.test(e.message));
  assert.deepEqual(store.events(f.board), before, 'a refused reservation appends nothing');
  assert.equal(reviewEligibility(f.board, item, { familyPolicy: 'require' }).tier, 'strict');
  assert.deepEqual(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible, ['core-5']);
});

test('next offers a review only to an eligible seat [V4,B26]', t => {
  const f = fixture(t), same = f.add(), eligible = f.add();
  f.submit(same, 'core-2');
  f.submit(eligible, 'core-1');
  const offered = store.reserveNextReview(f.board, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'require' });
  assert.equal(offered.item.item_id, eligible, 'the older same-vendor item is never offered');
  const queue = workQueue(f.board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }, 'core-5', { familyPolicy: 'require' });
  const ids = [...queue.releases.flatMap(r => r.items), ...queue.unreleased].map(item => item.id);
  assert.equal(ids.includes(same), false, 'the work queue uses the same vendor rule');
  assert.equal(ids.includes(eligible), true);
});

test('Pre-composition: Strict permits its own reservation and verdict but an ordinary check still counts as a write [V4,B26]', t => {
  const f = fixture(t); f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1; const id = f.add({ sensitive: true });
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
  for (const actor of ['core-6', 'core-4', 'core-7']) assert.throws(() => f.reserve(id, actor), e => e.code === 'REQUIRED_REVIEW_FAMILY');
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
  assert.deepEqual(reviewEligibility(replica, store.getItem(replica, id), { familyPolicy: 'require' }).eligible,
    reviewEligibility(f.board, store.getItem(f.board, id), { familyPolicy: 'require' }).eligible);
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


test('unknown-family refusal is opt-in and known vendors retain off prefer require [V4,B26,H16]', t => {
  const f = fixture(t, { requireFamilies: false });
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/optional-unknown' });
  const unknownReviewer = f.add(), sameVendor = f.add(), required = f.add(), unknownBuilder = f.add();
  f.submit(unknownReviewer); f.submit(sameVendor); f.submit(required); f.submit(unknownBuilder, 'core-6');
  const reserve = (id, agentId, familyPolicy = 'off') => store.reserveReview(f.board, id,
    { agentId, leaseMs: LEASE, policy: 'any', familyPolicy });
  assert.equal(store.lineSettings(f.board).requireReviewFamilies, false);
  assert.equal(reserve(unknownReviewer, 'core-6').item_review_by, 'core-6', 'off retains an optional unknown reviewer');
  assert.equal(reserve(sameVendor, 'core-4', 'prefer').item_review_by, 'core-4', 'prefer retains known same-vendor eligibility');
  assert.equal(reserve(unknownBuilder, 'core-5').item_review_by, 'core-5', 'off retains an optional unknown builder');
  assert.throws(() => reserve(required, 'core-4', 'require'), { code: 'SAME_FAMILY' });
  assert.throws(() => reserve(required, 'core-6', 'require'), { code: 'O2_FAMILY_MATCH' });
  store.setLineSetting(f.board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: true,
    reason: 'Private setting-on contract requires an explicit vendor pair.', window: { syntheticSeats: 7 } });
  assert.throws(() => reserve(required, 'core-6', 'off'), { code: 'O2_FAMILY_MATCH' });
  assert.throws(() => reserve(unknownBuilder, 'core-5', 'off'), { code: 'O2_FAMILY_MATCH' }, 'on refuses an unknown builder as well as reviewer');
  assert.equal(reserve(required, 'core-4', 'off').item_review_by, 'core-4', 'the new setting does not reinterpret known vendor policy');
});

test('the review vendor setting defaults off and requires its native engine on replay [V4,B26,H16]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture/setting-coordinator' });
  assert.equal(store.lineSettings(board).requireReviewFamilies, false, 'absence is off without writing metadata');
  const options = { agentId: 'coordinator', key: 'requireReviewFamilies', value: true,
    reason: 'Synthetic ordered policy contract.', window: { syntheticSeats: 1 } };
  assert.equal(minimumMoveEngine('setLineSetting', [options]), REVIEW_INDEPENDENCE_ENGINE);
  const move = prepareEngineMove(board, 'setLineSetting', [options], { id: 'synthetic-review-vendor-policy' });
  const before = exportBoard(board);
  assert.throws(() => applyEngineMove(board, { ...move, engine: REVIEW_INDEPENDENCE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-27T00:00:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), before, 'unsupported replay refuses before any native state or cursor mutation');
  const current = applyEngineMove(board, { ...move, id: 'synthetic-review-vendor-policy-current' }, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
  assert.equal(current.error, undefined);
  assert.equal(store.lineSettings(board).requireReviewFamilies, true);
});


test('Pre-composition: engine 142 family records retain their shape and become Strict under modern review [V4,B26,H16]', t => {
  const f = fixture(t); f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1;
  f.board.executionEngineVersion = 142;
  const id = f.add({ reviewFamily: 'ClAuDe' });
  const added = store.events(f.board).find(event => event.event_kind === 'add' && event.item_id === id);
  assert.equal(JSON.parse(added.event_detail).reviewFamily, 'ClAuDe');
  assert.equal(Object.hasOwn(JSON.parse(added.event_detail), 'reviewPolicy'), false, 'sealed legacy add retains its native event shape');
  store.editItem(f.board, id, { agentId: 'coordinator', reviewFamily: 'CLAUDE' });
  const edited = store.events(f.board).filter(event => event.event_kind === 'edit' && event.item_id === id).at(-1);
  assert.equal(JSON.parse(edited.event_detail).reviewFamily, 'CLAUDE');
  assert.equal(Object.hasOwn(JSON.parse(edited.event_detail), 'reviewPolicy'), false);
  f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1;
  assert.deepEqual(itemReviewPolicy(f.board, id), { version: 1, sensitive: false, reviewFamily: 'CLAUDE', tier: 'strict' });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'Native old-family item is still strict after upgrade.' });
  f.submit(id);
  assert.throws(() => f.reserve(id, 'core-3'), { code: 'STRICT_REVIEW_TOUCHED' });
  assert.throws(() => f.reserve(id, 'core-4'), { code: 'REQUIRED_REVIEW_FAMILY' });
  assert.equal(f.reserve(id, 'core-5').item_review_by, 'core-5');
  const clear = f.add({ reviewFamily: 'claude' });
  store.editItem(f.board, clear, { agentId: 'coordinator', reviewFamily: null });
  assert.equal(itemReviewPolicy(f.board, clear).tier, 'standard');
  assert.equal(store.getItem(f.board, clear).item_review_family, undefined, 'modern clearing synchronizes legacy projection metadata');
});


test('Pre-composition: modern Strict policy fences old-engine reserve, selection and verdict replay [V4,B26,H16]', t => {
  for (const policy of [{ sensitive: true }, { reviewFamily: 'claude' }]) {
    for (const operation of ['reserveReview', 'reserveNextReview', 'verify']) {
      const f = fixture(t); f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1; const id = f.add(policy);
      store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'A real native write forbids this session under Strict.' });
      // Explicit synthetic frozen policy is required by real ordered verify replay, not runtime proof.
      store.claim(f.board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
        freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'synthetic-review-bar' }) });
      submitFixture(f.board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
      const item = store.getItem(f.board, id);
      const options = { agentId: 'core-3', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' };
      const args = operation === 'reserveNextReview' ? [options] : [id, operation === 'verify'
        ? { agentId: 'core-3', decision: 'ACCEPT', note: 'Synthetic replay authority control.', head: item.item_commit,
          digest: item.item_frozen_digest, policy: 'any', check: 'none' } : options];
      const move = prepareEngineMove(f.board, operation, args, { id: `strict-floor-${operation}-${id}` });
      move.engine = STRICT_COMPOSITION_ENGINE - 1;
      const before = exportBoard(f.board);
      assert.throws(() => applyEngineMove(f.board, { ...move, engine: 142 },
        { sequence: 1, at: '2026-10-27T00:01:00.000Z' }), { code: 'RELAY_MOVE' }, operation);
      assert.deepEqual(exportBoard(f.board), before, 'old engine cannot mutate item, verdict, reservation, receipt or cursor');
      const current = applyEngineMove(f.board, move, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
      assert.equal(operation === 'reserveNextReview' ? current.result?.item ?? null : current.error?.code,
        operation === 'reserveNextReview' ? null : 'STRICT_REVIEW_TOUCHED', 'modern replay enforces the session-write rule');
      if (operation === 'reserveNextReview') {
        assert.equal(current.error, undefined);
        assert.ok(current.result.reasons.some(reason => /Strict review refuses this session/.test(reason)));
      }
      assert.equal(store.getItem(f.board, id).item_status, 'submitted');
      assert.equal(store.getItem(f.board, id).item_review_by, null);
    }
  }
});


test('Pre-composition: ordered activation protects legacy family items and preserves genuine engine 142 receipts [V4,B26,H16]', t => {
  for (const activation of ['success', 'refusal']) {
  const f = fixture(t, { historical: true });
  f.board.clock = { now: () => new Date('2026-10-27T00:02:00.000Z') };
  const id = f.add({ reviewFamily: 'claude' });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'Historical item write becomes a Strict touch after rollout.' });
  f.submit(id);
  f.board.executionEngineVersion = STRICT_COMPOSITION_ENGINE - 1;
  const args = [id, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' }];
  const old = { ...prepareEngineMove(f.board, 'reserveReview', args, { id: 'genuine-142-review' }), engine: 142 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
  assert.equal(first.error, undefined, 'real historical 142 reservation is accepted before activation');
  const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
  store.release(f.board, id, 'core-5', 'Release the historical reservation before the rollout control.');
  const modern = activation === 'success'
    ? prepareEngineMove(f.board, 'appendFact', [id, { agentId: 'core-2', kind: 'note', text: 'Modern recorded native mutation activates review semantics.' }], { id: 'activate-review-prefix' })
    : prepareEngineMove(f.board, 'reserveReview', [id, { ...args[1], agentId: 'core-3' }], { id: 'activate-refusal-prefix' });
  modern.engine = STRICT_COMPOSITION_ENGINE - 1;
  const activated = applyEngineMove(f.board, modern, { sequence: 2, at: '2026-10-27T00:02:00.000Z' });
  assert.equal(activated.error?.code, activation === 'success' ? undefined : 'STRICT_REVIEW_TOUCHED');
  const newArgs = [id, { ...args[1], agentId: 'core-3' }];
  const next = prepareEngineMove(f.board, 'reserveReview', newArgs, { id: 'new-review-old-item' });
  next.engine = STRICT_COMPOSITION_ENGINE - 1;
  const before = exportBoard(f.board);
  assert.throws(() => applyEngineMove(f.board, { ...next, engine: 142 },
    { sequence: 3, at: '2026-10-27T00:03:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(f.board), before);
  assert.equal(applyEngineMove(f.board, next, { sequence: 3, at: '2026-10-27T00:03:00.000Z' }).error.code, 'STRICT_REVIEW_TOUCHED');
  const replayBefore = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' }), first);
  assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
  assert.deepEqual(exportBoard(f.board), replayBefore, 'already recorded old receipt replays byte-identically after activation');
  }
});


test('strict vendor eligibility and native reservation agree while historical reviews retain their policy [C7,V4,B26,H16]', t => {
  for (const historical of [true, false]) {
    const f = fixture(t, { requireFamilies: false });
    const id = f.add({ sensitive: true, reviewFamily: null });
    const item = f.submit(id);
    if (historical) f.board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
    const eligibility = reviewEligibility(f.board, item, { familyPolicy: 'off' });
    assert.equal(eligibility.tier, 'strict');
    assert.equal(eligibility.eligible.includes('core-4'), historical, 'same-vendor untouched session follows the recorded routing engine');
    assert.ok(eligibility.eligible.includes('core-5'), 'a different-vendor untouched session stays eligible');
    const options = { agentId: 'core-4', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' };
    if (historical) assert.equal(store.reserveReview(f.board, id, options).item_review_by, 'core-4');
    else {
      assert.equal(eligibility.ineligible.find(entry => entry.agent === 'core-4').code, 'SAME_FAMILY');
      const before = exportBoard(f.board);
      assert.throws(() => store.reserveReview(f.board, id, options), { code: 'SAME_FAMILY' });
      assert.deepEqual(exportBoard(f.board), before, 'refusal changes no native state');
      assert.equal(store.reserveReview(f.board, id, { ...options, agentId: 'core-5' }).item_review_by, 'core-5');
    }
  }
});



test('routing activation fences vendor-rule downgrades while genuine historical receipts replay unchanged [C7,V4,B26,H16]', t => {
  for (const operation of ['reserveReview', 'reserveNextReview', 'verify']) {
    const f = fixture(t, { requireFamilies: false, engine: REVIEW_ROUTING_ENGINE - 1 });
    f.board.clock = { now: () => new Date('2026-10-27T00:02:00.000Z') };
    const id = f.add({ sensitive: true, reviewFamily: null });
    store.claim(f.board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
      freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'synthetic-routing-bar' }) });
    submitFixture(f.board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    const item = store.getItem(f.board, id);
    const options = { agentId: 'core-4', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' };
    const old = { ...prepareEngineMove(f.board, 'reserveReview', [id, options], { id: 'genuine-pre-routing-reservation' }), engine: REVIEW_ROUTING_ENGINE - 1 };
    const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
    assert.equal(first.error, undefined, 'the historical known-vendor policy allowed this untouched session');
    const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
    delete f.board.executionEngineVersion;
    store.release(f.board, id, 'core-4', 'Release the historical review before routing activation.', 'OTHER');
    assert.throws(() => store.reserveReview(f.board, id, options), { code: 'REVIEW_COOLDOWN' });
    // Honor the real release cooldown before asking the independent vendor guard to decide.
    f.board.clock = { now: () => new Date('2026-10-27T01:03:00.000Z') };
    const activate = prepareEngineMove(f.board, 'appendFact', [id, { agentId: 'coordinator', kind: 'note', text: 'Activate the modern recorded routing prefix.' }]);
    assert.equal(applyEngineMove(f.board, activate, { sequence: 2, at: '2026-10-27T01:03:00.000Z' }).error, undefined);
    const args = operation === 'reserveNextReview' ? [options] : [id, operation === 'verify'
      ? { agentId: 'core-4', decision: 'ACCEPT', note: 'Synthetic vendor-downgrade control.', head: item.item_commit,
        digest: item.item_frozen_digest, policy: 'any', check: 'none' } : options];
    const fresh = prepareEngineMove(f.board, operation, args);
    const before = exportBoard(f.board);
    assert.throws(() => applyEngineMove(f.board, { ...fresh, engine: REVIEW_ROUTING_ENGINE - 1 },
      { sequence: 3, at: '2026-10-27T01:04:00.000Z' }), { code: 'RELAY_MOVE' }, operation);
    assert.deepEqual(exportBoard(f.board), before, 'downgrade refusal changes no state or cursor');
    const current = applyEngineMove(f.board, fresh, { sequence: 3, at: '2026-10-27T01:04:00.000Z' });
    assert.equal(operation === 'reserveNextReview' ? current.result?.item ?? null : current.error?.code,
      operation === 'reserveNextReview' ? null : 'SAME_FAMILY');
    const replayBefore = exportBoard(f.board);
    assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' }), first);
    assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
    assert.deepEqual(exportBoard(f.board), replayBefore, 'genuine old receipt keeps its exact outcome and bytes');
  }
});

test('an explicit alias makes one vendor one family, while a true cross-family reviewer stays eligible [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add();
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/core-6', family: 'OpenAI Inc', parentDigest: 'f'.repeat(64), model: 'Synthetic fixture model' });
  const item = f.submit(id);
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), 'without an alias, an unlisted OpenAI Inc spelling remains distinct');
  f.board.familyAliases = familyIndex({ openai: ['codex', 'OpenAI Inc'] });
  const projected = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.equal(projected.eligible.includes('core-6'), false, 'an aliased spelling of the builder family is the same vendor');
  assert.ok(projected.ineligible.some(row => row.agent === 'core-6' && row.code === 'SAME_FAMILY'));
  assert.ok(projected.eligible.includes('core-2'), 'a reviewer from a different vendor remains eligible');
});

test('a strict submit whose builder declared no vendor family is refused with the join fix [V4,B26]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  store.register(f.board, { id: 'core-7', lane: 'core', path: '/fixture/core-7', parentDigest: '7'.repeat(64), model: 'Synthetic fixture model' });
  store.claim(f.board, id, { agentId: 'core-7', lane: 'core', leaseMs: LEASE, freeze });
  assert.throws(() => store.submit(f.board, id, { agentId: 'core-7', commit: 'c'.repeat(40), tree: 'd'.repeat(40), files: [] }), error => error.code === 'UNDECLARED_BUILDER_FAMILY'
    && /pullboard join <lane> --family <vendor>/u.test(error.message));
});

test('aliases installed by the production accessor reach the review projection, which spreads the board [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/core-6', family: 'OpenAI', parentDigest: 'f'.repeat(64), model: 'Synthetic fixture model' });
  const item = f.submit(id);
  // The same non-enumerable accessor shape cli-read-context.js installs on a real board.
  let aliases;
  Object.defineProperty(f.board, 'familyAliases', { configurable: true, get: () => aliases ??= familyIndex({ openai: ['codex'] }) });
  const projected = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.equal(projected.eligible.includes('core-6'), false, 'an OpenAI reviewer of a codex builder is the same vendor on the production path');
  assert.ok(projected.ineligible.some(row => row.agent === 'core-6' && row.code === 'SAME_FAMILY'));
});

/** Register one extra seat with a declared vendor family and its own persisted parent session. */
function joinSeat(board, id, family, parent) {
  store.register(board, { id, lane: 'core', path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
}

test('a companion patch author of another spelling blocks only itself; the head builder alone sets the judged family [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  joinSeat(f.board, 'core-6', 'OpenAI', '6');
  joinSeat(f.board, 'core-7', 'gemini', '7');
  const item = f.submit(id, 'core-2');
  const author = { agentId: 'core-1', parentSession: null, session: null };
  f.board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`item_patches:${id}`,
    JSON.stringify({ version: 1, patches: [{ key: 'companion', commit: 'c'.repeat(40), digest: 'd'.repeat(64), active: true, author }] }));
  // Strict review judges the submitted head builder's family only (a9f6ac5f19, #2868): a companion's vendor excludes no one else.
  assert.equal(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), true, 'the built-in vendor table does not extend the companion author vendor to other seats');
  f.board.familyAliases = familyIndex({ openai: ['codex'] });
  const projected = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.ok(projected.eligible.includes('core-6'), 'the alias list adds no exclusion for the companion author vendor');
  assert.ok(!projected.ineligible.some(row => row.agent === 'core-6'));
  assert.ok(projected.ineligible.some(row => row.agent === 'core-1'), 'the companion author is itself excluded');
  assert.ok(projected.eligible.includes('core-7'), 'a third vendor remains eligible');
  assert.doesNotThrow(() => f.reserve(id, 'core-6'));
});

test('the real withOpenedBoard installs the alias list from accepted main and the projection keeps it [V4,B26]', t => {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, families: { openai: ['codex', 'OpenAI Inc'] } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: declare vendor aliases');
  // The opener closes its board, so this one is not also closed by a test hook.
  const f = fixture({ after() {} }), id = f.add();
  joinSeat(f.board, 'core-6', 'OpenAI Inc', '6');
  const item = f.submit(id);
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), 'before opening, no alias index exists');
  const eligible = withOpenedBoard({ info: { root: box.repo, isMain: true }, io: {} }, board => reviewEligibility(board, item, { familyPolicy: 'require' }), f.board);
  assert.equal(eligible.eligible.includes('core-6'), false, 'an alias committed on main reaches the review projection through the production opener');
  assert.ok(eligible.eligible.includes('core-2'));
});

test('aliases and the strict builder rule apply only from their engine; an older sealed move replays unchanged [C7,V4,B26,H16]', t => {
  const f = fixture(t, { requireFamilies: false, engine: FAMILY_ALIAS_ENGINE - 1 });
  f.board.clock = { now: () => new Date('2026-10-28T00:02:00.000Z') };
  joinSeat(f.board, 'core-6', 'OpenAI', '6');
  const id = f.add({ sensitive: true, reviewFamily: null }), item = f.submit(id);
  assert.ok(item, 'the strict item is submitted by a codex builder');
  f.board.familyAliases = familyIndex({ openai: ['codex'] });
  const options = { agentId: 'core-6', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' };
  const old = { ...prepareEngineMove(f.board, 'reserveReview', [id, options], { id: 'genuine-pre-alias-reservation' }), engine: FAMILY_ALIAS_ENGINE - 1 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T00:01:00.000Z' });
  assert.equal(first.error, undefined, 'recorded before aliases existed, OpenAI and codex were two vendors');
  const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
  delete f.board.executionEngineVersion;
  store.release(f.board, id, 'core-6', 'Release the historical review before the alias engine applies.', 'OTHER');
  f.board.clock = { now: () => new Date('2026-10-28T01:03:00.000Z') };
  const fresh = prepareEngineMove(f.board, 'reserveReview', [id, options]);
  assert.equal(applyEngineMove(f.board, fresh, { sequence: 2, at: '2026-10-28T01:04:00.000Z' }).error?.code, 'SAME_FAMILY', 'the current engine applies the alias');
  const after = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T00:01:00.000Z' }), first);
  assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
  assert.deepEqual(exportBoard(f.board), after, 'the older receipt keeps its exact outcome and bytes');
  // The undeclared-builder refusal is equally fenced: a strict submit under an older engine still records.
  const older = fixture(t), strictId = older.add({ sensitive: true });
  older.board.executionEngineVersion = FAMILY_ALIAS_ENGINE - 1;
  joinSeat(older.board, 'core-8', null, '8');
  store.claim(older.board, strictId, { agentId: 'core-8', lane: 'core', leaseMs: LEASE, freeze });
  assert.doesNotThrow(() => submitFixture(older.board, strictId, { agentId: 'core-8', commit: 'c'.repeat(40), tree: 'd'.repeat(40) }));
});

test('at engine 148 a differently cased family is another vendor; only the alias engine folds case [C7,V4,B26,H16]', t => {
  const f = fixture(t, { requireFamilies: false });
  joinSeat(f.board, 'core-9', 'CODEX', '9');
  const id = f.add(), item = f.submit(id);
  const options = { agentId: 'core-9', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'require' };
  f.board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE;
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-9'), 'engine 148 compared the declared labels exactly: codex and CODEX differ');
  delete f.board.executionEngineVersion;
  const current = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.equal(current.eligible.includes('core-9'), false, 'the current engine folds case into one family');
  assert.ok(current.ineligible.some(row => row.agent === 'core-9' && row.code === 'SAME_FAMILY'));
  assert.throws(() => store.reserveReview(f.board, id, options), { code: 'SAME_FAMILY' });
  f.board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE;
  assert.equal(store.reserveReview(f.board, id, options).item_review_by, 'core-9', 'the same reservation still records under engine 148');
  const waiting = fixture(t, { requireFamilies: false }), same = waiting.add();
  joinSeat(waiting.board, 'core-9', 'CODEX', '9');
  waiting.submit(same);
  waiting.board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE;
  assert.equal(store.reserveNextReview(waiting.board, { ...options, familyPolicy: 'require' }).item?.item_id, same, 'selection at engine 148 offers the codex item to a CODEX seat');
});

test('an undeclared seat declares its vendor family once from a new session and becomes reviewable; a declared seat is refused a change [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  f.board.familyAliases = familyIndex({ anthropic: ['claude-family'] });
  const seat = { id: 'core-7', lane: 'core', path: '/fixture/core-7', model: 'Synthetic fixture model' };
  store.register(f.board, { ...seat, parentDigest: '7'.repeat(64) });
  f.submit(id, 'core-1');
  assert.throws(() => f.reserve(id, 'core-7'), error => error.code === 'O2_FAMILY_MATCH', 'an undeclared seat cannot review a strict item');
  const parentOf = () => f.board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='agent_parent_session:core-7'").get()?.meta_value;
  const before = parentOf();
  // The same seat joined again from another session: before this engine that was PARENT_SESSION_CHANGED.
  const again = (family, parent = '9') => store.register(f.board, { ...seat, family, parentDigest: parent.repeat(64) });
  assert.equal(again('Anthropic'), 'core-7');
  assert.equal(f.board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('core-7').agent_family, 'Anthropic');
  const events = f.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='family' AND event_by='core-7'").all();
  assert.equal(events.length, 1, 'the declaration is one board event');
  assert.equal(parentOf(), before, 'the recorded parent session is untouched');
  assert.doesNotThrow(() => f.reserve(id, 'core-7'), 'the declared seat is now reviewable');
  assert.throws(() => again('OpenAI'), error => error.code === 'FAMILY_DECLARED', 'a declared seat is refused a change from another session');
  assert.equal(f.board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('core-7').agent_family, 'Anthropic', 'a refused declaration changes nothing');
});

test('a declared alias spelling is the builder\'s vendor, so that seat still cannot review [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  f.board.familyAliases = familyIndex({ claude: ['claude-family'] });
  const seat = { id: 'core-9', lane: 'core', path: '/fixture/core-9', model: 'Synthetic fixture model' };
  store.register(f.board, { ...seat, parentDigest: '7'.repeat(64) });
  f.submit(id, 'core-2');
  store.register(f.board, { ...seat, family: 'claude-family', parentDigest: '9'.repeat(64) });
  assert.throws(() => f.reserve(id, 'core-9'), error => error.code === 'SAME_FAMILY', 'the declared name goes through the alias list');
});

test('a declared seat rejoining from the SAME session cannot change vendor, and another spelling of it is the same declaration [V4,B26,H16]', t => {
  const f = fixture(t);
  f.board.familyAliases = familyIndex({ openai: ['OpenAI Inc'] });
  const seat = { id: 'core-10', lane: 'core', path: '/fixture/core-10', model: 'Synthetic fixture model', parentDigest: '5'.repeat(64) };
  store.register(f.board, { ...seat, family: 'openai' });
  assert.throws(() => store.register(f.board, { ...seat, family: 'Claude' }), error => error.code === 'FAMILY_DECLARED' && /never changed/u.test(error.message));
  assert.equal(f.board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('core-10').agent_family, 'openai', 'the refused rejoin changed nothing');
  assert.equal(store.register(f.board, { ...seat, family: 'OpenAI Inc' }), 'core-10', 'an alias of the declared vendor is the same declaration');
  assert.equal(store.register(f.board, { ...seat, family: null }), 'core-10', 'a join naming no family keeps the declaration');
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  assert.doesNotThrow(() => store.register(f.board, { ...seat, family: 'Claude' }), 'below the engine a same-session rejoin keeps its old update');
});

test('declared, then cleared with null or blank, then redeclared as another vendor ends refused and still declared [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-11', lane: 'core', path: '/fixture/core-11', model: 'Synthetic fixture model', parentDigest: '6'.repeat(64) };
  const family = () => f.board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('core-11').agent_family;
  store.register(f.board, { ...seat, family: 'OpenAI' });
  for (const cleared of [null, '', '  ']) {
    assert.equal(store.register(f.board, { ...seat, family: cleared }), 'core-11', 'clearing is not an error');
    assert.equal(family(), 'OpenAI', `a ${JSON.stringify(cleared)} family clears nothing`);
    for (const parentDigest of [seat.parentDigest, '7'.repeat(64)]) {
      assert.throws(() => store.register(f.board, { ...seat, family: 'Claude', parentDigest }), error => error.code === 'FAMILY_DECLARED', 'the other vendor is refused after the clearing, in the same or a new session');
      assert.equal(family(), 'OpenAI', 'the refused redeclaration changes nothing');
    }
  }
  const changes = f.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='family' AND event_by='core-11'").all();
  assert.deepEqual(changes, [], 'no family change was recorded after the declaration');
});

test('the one-time family declaration applies only from its engine; an older engine keeps the session refusal [C7,V4,B26,H16]', t => {
  const f = fixture(t);
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  const seat = { id: 'core-8', lane: 'core', path: '/fixture/core-8', model: 'Synthetic fixture model' };
  store.register(f.board, { ...seat, parentDigest: '8'.repeat(64) });
  assert.throws(() => store.register(f.board, { ...seat, family: 'Anthropic', parentDigest: '9'.repeat(64) }), error => error.code === 'PARENT_SESSION_CHANGED');
});

/** Read the seat's family column directly: the value review eligibility reads. */
const familyOf = (board, id) => seatFamily(board, id);

test('counterexample: after a modern declaration, a fresh older-engine registration cannot clear the family for a later redeclaration [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-7', lane: 'core', path: '/fixture/core-7', model: 'Synthetic fixture model', parentDigest: 'a'.repeat(64), sessionDigest: 'b'.repeat(64) };
  const declare = applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, family: 'OpenAI' }], { id: 'modern-declare' }), { sequence: 1, at: '2026-10-28T19:00:00.000Z' });
  assert.equal(declare.error, undefined);
  assert.equal(familyOf(f.board, 'core-7'), 'OpenAI');
  for (const engine of [FAMILY_DECLARE_ENGINE - 1, 148, 1]) {
    const old = { ...prepareEngineMove(f.board, 'register', [{ ...seat, family: null }], { id: `fresh-old-clear-${engine}` }), engine };
    const before = exportBoard(f.board);
    assert.throws(() => applyEngineMove(f.board, old, { sequence: 2, at: '2026-10-28T19:01:00.000Z' }), { code: 'RELAY_MOVE' }, `a fresh engine ${engine} registration after the modern prefix is refused`);
    assert.deepEqual(exportBoard(f.board), before, 'the refused older move changes no seat, receipt or cursor');
  }
  const redeclare = applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, family: 'Claude' }], { id: 'modern-redeclare' }), { sequence: 2, at: '2026-10-28T19:02:00.000Z' });
  assert.equal(redeclare.error?.code, 'FAMILY_DECLARED', 'the modern redeclaration as another vendor is refused');
  assert.equal(familyOf(f.board, 'core-7'), 'OpenAI', 'the seat ends still OpenAI');
});

test('a genuine older-engine registration recorded before the modern prefix still replays byte for byte [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-12', lane: 'core', path: '/fixture/core-12', model: 'Synthetic fixture model', parentDigest: 'c'.repeat(64) };
  const old = { ...prepareEngineMove(f.board, 'register', [{ ...seat, family: 'OpenAI' }], { id: 'genuine-old-register' }), engine: FAMILY_DECLARE_ENGINE - 1 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T18:00:00.000Z' });
  assert.equal(first.error, undefined, 'before any modern move an older registration is accepted under its own rules');
  const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
  applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, family: 'openai' }], { id: 'modern-same-vendor' }), { sequence: 2, at: '2026-10-28T18:01:00.000Z' });
  const before = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T18:00:00.000Z' }), first, 'the recorded receipt replays its original outcome after activation');
  assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
  assert.deepEqual(exportBoard(f.board), before, 'replaying the genuine receipt changes nothing');
});

test('a family cleared below the engine is still declared: a later modern redeclaration as another vendor is refused [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-13', lane: 'core', path: '/fixture/core-13', model: 'Synthetic fixture model', parentDigest: 'd'.repeat(64) };
  store.register(f.board, { ...seat, family: 'OpenAI' });
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  store.register(f.board, { ...seat, family: null }); // The pre-engine rule applies directly; ordered fresh moves are fenced above.
  assert.equal(familyOf(f.board, 'core-13'), null);
  delete f.board.executionEngineVersion;
  for (const parentDigest of [seat.parentDigest, '9'.repeat(64)]) {
    assert.throws(() => store.register(f.board, { ...seat, family: 'Claude', parentDigest }), error => error.code === 'FAMILY_DECLARED',
      'the recorded first declaration outlives a cleared column, in the same or another session');
  }
  // A seat declared only under an older engine is still declared: its recorded family event is the evidence.
  const legacy = { id: 'core-14', lane: 'core', path: '/fixture/core-14', model: 'Synthetic fixture model', parentDigest: 'e'.repeat(64) };
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  store.register(f.board, legacy);
  store.register(f.board, { ...legacy, family: 'OpenAI' });
  store.register(f.board, { ...legacy, family: null });
  delete f.board.executionEngineVersion;
  assert.throws(() => store.register(f.board, { ...legacy, family: 'Claude' }), error => error.code === 'FAMILY_DECLARED', 'a legacy OpenAI-null-Claude path is refused');
});

test('spelling, blank and session variants never change a declared vendor [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-15', lane: 'core', path: '/fixture/core-15', model: 'Synthetic fixture model', parentDigest: 'f'.repeat(64) };
  store.register(f.board, { ...seat, family: 'OpenAI' });
  for (const same of ['openai', 'OPENAI', ' OpenAI ', '\tOpenAI\n']) {
    assert.equal(store.register(f.board, { ...seat, family: same }), 'core-15', `${JSON.stringify(same)} is the same declaration`);
    assert.equal(familyOf(f.board, 'core-15'), 'OpenAI', 'and does not rewrite it');
  }
  for (const blank of [null, '', ' ', '\t\n', undefined]) {
    store.register(f.board, { ...seat, family: blank });
    assert.equal(familyOf(f.board, 'core-15'), 'OpenAI', `${JSON.stringify(blank)} clears nothing`);
  }
  for (const other of ['Claude', 'claude', 'OpenAI2', 'Open AI', 'OpenAΙ', 'anthropic']) {
    for (const digests of [{}, { parentDigest: '1'.repeat(64) }, { sessionDigest: '2'.repeat(64) }]) {
      assert.throws(() => store.register(f.board, { ...seat, ...digests, family: other }), error => error.code === 'FAMILY_DECLARED', `${JSON.stringify(other)} is another vendor`);
    }
  }
  assert.equal(familyOf(f.board, 'core-15'), 'OpenAI');
  assert.deepEqual(f.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='family' AND event_by='core-15'").all(), [], 'no change was recorded');
});

test('fresh modern registrations under new move ids cannot walk a declared seat through null to another vendor [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-16', lane: 'core', path: '/fixture/core-16', model: 'Synthetic fixture model', parentDigest: '3'.repeat(64) };
  let sequence = 0;
  const send = (family, extra = {}) => applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, ...extra, family }], { id: `walk-${sequence}` }),
    { sequence: ++sequence, at: new Date(Date.parse('2026-10-28T20:00:00Z') + sequence * 1000).toISOString() });
  assert.equal(send('OpenAI').error, undefined);
  for (const step of [null, '', 'Claude', null, 'claude', ' ', 'Anthropic']) {
    const outcome = send(step, { parentDigest: sequence % 2 ? '4'.repeat(64) : seat.parentDigest });
    if (typeof step === 'string' && step.trim()) assert.equal(outcome.error?.code, 'FAMILY_DECLARED', `step ${JSON.stringify(step)} is refused`);
    assert.equal(familyOf(f.board, 'core-16'), 'OpenAI', `after ${JSON.stringify(step)} the seat is still OpenAI`);
  }
});

test('counterexample: a cause or landing fence on a fresh older-engine registration cannot skip the activated family floor [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-17', lane: 'core', path: '/fixture/core-17', model: 'Synthetic fixture model', parentDigest: '8'.repeat(64) };
  let sequence = 0;
  const at = () => new Date(Date.parse('2026-10-28T21:00:00Z') + sequence * 1000).toISOString();
  assert.equal(applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, family: 'OpenAI' }], { id: 'cause-modern-declare' }), { sequence: ++sequence, at: at() }).error, undefined);
  // The exact rejected path: the supported second argument names a conflict cause.
  const exact = { ...prepareEngineMove(f.board, 'register', [{ ...seat, family: 'Claude' }, { cause: 'conflict:family-floor-control' }], { id: 'cause-exact' }), engine: FAMILY_DECLARE_ENGINE - 1 };
  const before = exportBoard(f.board);
  assert.throws(() => applyEngineMove(f.board, exact, { sequence: sequence + 1, at: at() }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(f.board), before, 'the caused older move changes nothing');
  assert.equal(familyOf(f.board, 'core-17'), 'OpenAI');
  // Every branch the floor reads: each cause family, other strings, non-strings and the landing fence, at every older engine.
  const causes = [undefined, 'conflict:family-floor-control', 'conflict:', 'sentinel:family-floor-control', 'sentinel:', 'other:cause', '', ' conflict:x', 'CONFLICT:x', 42, null, {}, ['conflict:x']];
  const shapes = causes.flatMap(cause => [[{ ...seat, family: 'Claude' }, cause === undefined ? undefined : { cause }],
    [{ ...seat, family: null }, { cause }], [{ ...seat, family: 'Claude', landingFence: 1 }, { cause }]]);
  let index = 0;
  for (const engine of [FAMILY_DECLARE_ENGINE - 1, 148, 1]) {
    for (const args of shapes) {
      const move = { ...prepareEngineMove(f.board, 'register', args.filter(value => value !== undefined), { id: `cause-sweep-${index++}` }), engine };
      const snapshot = exportBoard(f.board);
      assert.throws(() => applyEngineMove(f.board, move, { sequence: sequence + 1, at: at() }), { code: 'RELAY_MOVE' }, `${JSON.stringify(args[1])} at engine ${engine}`);
      assert.deepEqual(exportBoard(f.board), snapshot);
    }
  }
  assert.equal(familyOf(f.board, 'core-17'), 'OpenAI', 'after the whole sweep the seat is still OpenAI');
});

test('a caused older-engine registration recorded before the modern prefix still replays byte for byte [V4,B26,H16]', t => {
  const f = fixture(t);
  const seat = { id: 'core-18', lane: 'core', path: '/fixture/core-18', model: 'Synthetic fixture model', parentDigest: '9'.repeat(64) };
  const old = { ...prepareEngineMove(f.board, 'register', [{ ...seat, family: 'OpenAI' }, { cause: 'conflict:historical' }], { id: 'genuine-caused-register' }), engine: FAMILY_DECLARE_ENGINE - 1 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T18:00:00.000Z' });
  assert.equal(first.error, undefined, 'before activation the caused older registration follows its own rules');
  applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ ...seat, family: 'openai' }], { id: 'caused-modern-same' }), { sequence: 2, at: '2026-10-28T18:01:00.000Z' });
  const before = exportBoard(f.board);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-28T18:00:00.000Z' }), first);
  assert.deepEqual(exportBoard(f.board), before);
});

test('counterexample: a new seat of an original session that declared OpenAI inherits it and cannot declare Claude [V4,B26,H16]', t => {
  const f = fixture(t);
  const ids = { parentDigest: 'p'.replace('p', 'a').repeat(64), sessionDigest: 'b'.repeat(64) };
  store.register(f.board, { id: 'core-19', lane: 'core', path: '/fixture/core-19', model: 'Synthetic fixture model', ...ids, family: 'OpenAI' });
  const before = exportBoard(f.board);
  assert.throws(() => store.register(f.board, { id: 'core-20', lane: 'core', path: '/fixture/core-20', model: 'Synthetic fixture model', ...ids, family: 'Claude' }),
    error => error.code === 'FAMILY_DECLARED', 'view-215: seat C of the same original session and parent is refused Claude');
  assert.deepEqual(exportBoard(f.board), before, 'the refused seat is not created');
  for (const [path, family] of [['/fixture/core-21', undefined], ['/fixture/core-22', null], ['/fixture/core-23', '  '], ['/fixture/core-24', 'openai']]) {
    const id = store.register(f.board, { lane: 'core', path, model: 'Synthetic fixture model', ...ids, ...(family === undefined ? {} : { family }) });
    assert.equal(familyOf(f.board, id), 'OpenAI', `a new seat of the session joining with ${JSON.stringify(family)} inherits the first declared spelling`);
    assert.throws(() => store.register(f.board, { lane: 'core', path, model: 'Synthetic fixture model', ...ids, family: 'Claude' }), error => error.code === 'FAMILY_DECLARED');
  }
  // A seat that joined without a session later rejoining from that session is refused too.
  const loose = store.register(f.board, { lane: 'core', path: '/fixture/core-25', model: 'Synthetic fixture model', parentDigest: ids.parentDigest });
  assert.throws(() => store.register(f.board, { lane: 'core', path: '/fixture/core-25', model: 'Synthetic fixture model', parentDigest: ids.parentDigest, sessionDigest: ids.sessionDigest, family: 'Claude' }),
    error => error.code === 'FAMILY_DECLARED' || error.code === 'PARENT_SESSION_CHANGED', 'the session is the declaring one');
  assert.notEqual(familyOf(f.board, loose), 'Claude');
  // Positive control: a genuinely different session T may declare Claude, with the same parent.
  const other = store.register(f.board, { lane: 'core', path: '/fixture/core-26', model: 'Synthetic fixture model', parentDigest: ids.parentDigest, sessionDigest: 'c'.repeat(64), family: 'Claude' });
  assert.equal(familyOf(f.board, other), 'Claude', 'another session declares its own vendor');
});

test('a session declared through an ordered modern move is inherited by a new seat from that session [V4,B26,H16]', t => {
  const f = fixture(t);
  const ids = { parentDigest: 'd'.repeat(64), sessionDigest: 'e'.repeat(64) };
  assert.equal(applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ lane: 'core', path: '/fixture/s-1', model: 'Synthetic fixture model', ...ids, family: 'OpenAI' }], { id: 'session-a' }), { sequence: 1, at: '2026-10-28T21:00:00.000Z' }).error, undefined);
  const refused = applyEngineMove(f.board, prepareEngineMove(f.board, 'register', [{ lane: 'core', path: '/fixture/s-2', model: 'Synthetic fixture model', ...ids, family: 'Claude' }], { id: 'session-c' }), { sequence: 2, at: '2026-10-28T21:01:00.000Z' });
  assert.equal(refused.error?.code, 'FAMILY_DECLARED');
  assert.equal(store.agentAt(f.board, '/fixture/s-2'), undefined, 'no seat C was created');
});

/** An ordered-move board: a counter for sequences, and helpers that apply a fresh move at a chosen engine. */
function orderedBoard(t) {
  const f = fixture(t);
  let sequence = 0;
  const at = () => new Date(Date.parse('2026-10-28T22:00:00Z') + sequence * 1000).toISOString();
  let n = 0;
  /** Apply one fresh register move under a new move id; returns the outcome, or the refusal code thrown before it. */
  const send = (who, { engine, cause } = {}) => {
    const prepared = prepareEngineMove(f.board, 'register', cause === undefined ? [who] : [who, { cause }], { id: `sweep-${n++}` });
    const move = engine === undefined ? prepared : { ...prepared, engine };
    try {
      const outcome = applyEngineMove(f.board, move, { sequence: sequence + 1, at: at() });
      sequence += 1;
      return outcome;
    } catch (error) { if (error.code === 'RELAY_MOVE') return { thrown: 'RELAY_MOVE' }; throw error; }
  };
  return { ...f, send };
}

test('counterexample: a fresh older-engine registration at a NEW path from a declared session is refused [V4,B26,H16]', t => {
  const f = orderedBoard(t);
  const ids = { parentDigest: 'a'.repeat(64), sessionDigest: 'b'.repeat(64) };
  assert.equal(f.send({ lane: 'core', path: '/fixture/pathA', model: 'Synthetic fixture model', ...ids, family: 'OpenAI' }).error, undefined);
  const before = exportBoard(f.board);
  assert.deepEqual(f.send({ lane: 'core', path: '/fixture/pathB', model: 'Synthetic fixture model', ...ids, family: 'Claude' }, { engine: FAMILY_DECLARE_ENGINE - 1 }), { thrown: 'RELAY_MOVE' }, 'core-716: the new path no longer gets floor 1');
  assert.deepEqual(exportBoard(f.board), before);
  assert.equal(store.agentAt(f.board, '/fixture/pathB'), undefined);
});

test('adversarial sweep: every key a registration can vary cannot give a declared seat or session another vendor [V4,B26,H16]', t => {
  const f = orderedBoard(t);
  const S = 'b'.repeat(64), P = 'a'.repeat(64), T = 'c'.repeat(64), Q = 'd'.repeat(64);
  const raw = 'declaring-session-S2';
  assert.equal(f.send({ lane: 'core', path: '/fixture/A', model: 'Synthetic fixture model', parentDigest: P, sessionDigest: S, family: 'OpenAI' }).error, undefined);
  assert.equal(f.send({ lane: 'core', path: '/fixture/A2', model: 'Synthetic fixture model', parentDigest: P, session: raw, family: 'OpenAI' }).error, undefined);
  const seatA = store.agentAt(f.board, '/fixture/A').agent_id;
  const paths = ['/fixture/A', '/fixture/A/', '/fixture/B', '/fixture/brand-new'];
  const sessions = [{ sessionDigest: S }, { session: raw }, { sessionDigest: parentSessionDigestOf(raw) }, { sessionDigest: 'not-a-digest' }, { session: 'bad session id!' }];
  const parents = [{ parentDigest: P }, { parentDigest: Q }, {}];
  const families = ['Claude', 'claude', ' Claude ', 'CLAUDE', 'Anthropic', null, '', 'OpenAI', 'openai'];
  const engines = [FAMILY_DECLARE_ENGINE - 1, 1];
  /** A cheap whole-board fingerprint: every agent, event and metadata row, so a refused move provably changed nothing. */
  const fingerprint = () => JSON.stringify([f.board.db.prepare('SELECT * FROM agent ORDER BY agent_id').all(), f.board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n,
    f.board.db.prepare('SELECT meta_key, meta_value FROM board_meta ORDER BY meta_key').all()]);
  const claudeLike = family => typeof family === 'string' && family.trim() !== '' && family.trim().toLowerCase() !== 'openai';
  let checked = 0;
  for (const path of paths) for (const session of sessions) for (const parent of parents) for (const family of families) {
    const who = { lane: 'core', path, model: 'Synthetic fixture model', ...parent, ...session, family };
    // Every older engine, every cause shape and a named seat id: the activated floor refuses, changing nothing.
    for (const engine of engines) for (const extra of [{}, { id: seatA }]) for (const cause of [undefined, 'conflict:sweep']) {
      const before = fingerprint();
      const outcome = f.send({ ...who, ...extra }, { engine, cause });
      assert.deepEqual(outcome, { thrown: 'RELAY_MOVE' }, `engine ${engine} ${JSON.stringify({ ...who, ...extra, cause })} is refused`);
      assert.equal(fingerprint(), before);
      checked += 1;
    }
    // At the modern engine a Claude-like family is refused; every other value keeps or inherits OpenAI.
    const modern = f.send(who);
    if (claudeLike(family)) assert.ok(modern.error?.code === 'FAMILY_DECLARED' || modern.error?.code === 'PARENT_SESSION_CHANGED' || modern.error?.code === 'BAD_PARENT',
      `modern ${JSON.stringify(who)} is refused: ${JSON.stringify(modern.error)}`);
    const seat = store.agentAt(f.board, path);
    if (seat) assert.notEqual(familyName(seat.agent_family), 'claude', `${path} never becomes Claude`);
  }
  assert.ok(checked > 3000, `the sweep covered ${checked} older-engine moves`);
  for (const id of [seatA, store.agentAt(f.board, '/fixture/A2').agent_id]) assert.equal(familyName(familyOf(f.board, id)), 'openai', `${id} is still OpenAI`);
  // Positive controls: a genuinely different session declares Claude, at the modern engine and below it.
  assert.equal(f.send({ lane: 'core', path: '/fixture/T', model: 'Synthetic fixture model', parentDigest: P, sessionDigest: T, family: 'Claude' }).error, undefined);
  assert.equal(familyOf(f.board, store.agentAt(f.board, '/fixture/T').agent_id), 'Claude', 'a different session T declares Claude');
  const older = f.send({ lane: 'core', path: '/fixture/U', model: 'Synthetic fixture model', parentDigest: Q, sessionDigest: 'e'.repeat(64), family: 'Claude' }, { engine: FAMILY_DECLARE_ENGINE - 1 });
  assert.equal(older.thrown, undefined, 'an older-engine registration of an undeclared new seat and session keeps its engine\'s rules');
});

test('counterexample: after a historical null clear the first family is still derived from the original receipt [V4,B26,H16]', t => {
  const f = orderedBoard(t);
  const seat = { lane: 'core', path: '/fixture/core-h', model: 'Synthetic fixture model', parentDigest: 'a'.repeat(64), sessionDigest: 'b'.repeat(64) };
  const old = FAMILY_DECLARE_ENGINE - 1;
  const first = f.send({ ...seat, family: 'OpenAI' }, { engine: old });
  assert.equal(first.error, undefined, 'a genuine older-engine first registration records OpenAI');
  assert.equal(f.send({ ...seat, family: null }, { engine: old }).error, undefined, 'a genuine older-engine null clear, before activation');
  assert.equal(f.send({ lane: 'core', path: '/fixture/core-t', model: 'Synthetic fixture model', parentDigest: 'c'.repeat(64), sessionDigest: 'c'.repeat(64), family: 'Claude' }).error, undefined,
    'positive control: an independent session T declares Claude and activates the declaration engine');
  const id = store.agentAt(f.board, seat.path).agent_id;
  assert.equal(familyOf(f.board, id), 'OpenAI', 'the derived family is the first one recorded, not the cleared column');
  const modern = f.send({ ...seat, family: 'Claude' });
  assert.equal(modern.error?.code, 'FAMILY_DECLARED', 'view-213: the modern Claude registration of the same seat, path and session is refused');
  assert.equal(familyOf(f.board, id), 'OpenAI');
  for (const other of [{ ...seat, path: '/fixture/core-h2', family: 'Claude' }, { ...seat, path: '/fixture/core-h3', family: 'claude' }]) {
    assert.equal(f.send(other).error?.code, 'FAMILY_DECLARED', 'another seat of the same session is refused too');
  }
});

test('the derived family decides eligibility: a historically cleared seat still counts as its first vendor [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  const seat = { id: 'core-30', lane: 'core', path: '/fixture/core-30', model: 'Synthetic fixture model', parentDigest: '3'.repeat(64) };
  store.register(f.board, { ...seat, family: 'codex' });
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  store.register(f.board, { ...seat, family: null });
  delete f.board.executionEngineVersion;
  f.submit(id, 'core-1');
  assert.throws(() => f.reserve(id, 'core-30'), error => error.code === 'SAME_FAMILY',
    'the cleared column does not make core-30 an independent vendor of codex-built work');
});

test('no family decision reads the stored family column outside the one derivation [V4,B26,H16]', () => {
  const files = movedSourceFiles().filter(name => !name.includes('move-history'));
  // The three files that own the derivation: items' declaration, and the board schema and migration.
  const allowed = new Set(['packages/items/src/io/declaration.js', 'packages/store/src/io/board/schema/source.js', 'packages/store/src/io/board/migrate.js']);
  const offenders = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const lines = readFileSync(join(REPOSITORY, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Writes keep the display column; every read of it, by property or SELECT, must call seatFamily instead.
      if (/\.agent_family\b/u.test(line) || /SELECT[^;]*\bagent_family\b/u.test(line) || /\bagent_family\b/u.test(line) && !/UPDATE agent SET agent_family|INSERT INTO agent \(/u.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'family reads go through packages/items/src/io/declaration.js seatFamily');
  // Whole-row reads carry agent_family too: every SELECT * or agent.* projection of agent rows must derive it.
  const rowReads = [];
  // The old src/ files, then every file of the cells (the old packages/ folder), as the check always read both.
  for (const file of new Set([...files, ...sourceFiles().filter(name => name.startsWith('packages/'))])) {
    if (['packages/items/src/io/declaration.js', 'packages/store/src/io/exchange.js'].includes(file)) continue; // exchange.js validates raw exported tables.
    readFileSync(join(REPOSITORY, file), 'utf8').split('\n').forEach((line, index) => {
      if (/SELECT\s+\*\s+FROM\s+agent\b|SELECT\s+agent\.\*/u.test(line) && !/withDerivedFamil(?:y|ies)\(|withModel\(/u.test(line)) rowReads.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(rowReads, [], 'agent-row projections return the derived family');
});

test('counterexample: every public agent-row reader returns the derived family after a historical clear [V4,B26,H16]', t => {
  const f = orderedBoard(t);
  const seat = { lane: 'core', path: '/fixture/core-r', model: 'Synthetic fixture model', parentDigest: 'a'.repeat(64), sessionDigest: 'b'.repeat(64) };
  const old = FAMILY_DECLARE_ENGINE - 1;
  assert.equal(f.send({ ...seat, family: 'OpenAI' }, { engine: old }).error, undefined);
  assert.equal(f.send({ ...seat, family: null }, { engine: old }).error, undefined);
  assert.equal(f.send({ lane: 'core', path: '/fixture/core-rt', model: 'Synthetic fixture model', sessionDigest: 'c'.repeat(64), family: 'Claude' }).error, undefined, 'a modern move activates the declaration engine');
  const id = store.agentAt(f.board, seat.path).agent_id;
  assert.equal(store.agentAt(f.board, seat.path).agent_family, 'OpenAI', 'view-215: agentAt returns the derived family, not the cleared column');
  assert.equal(store.agentById(f.board, id).agent_family, 'OpenAI', 'agentById returns it');
  assert.equal(store.listAgents(f.board).find(agent => agent.agent_id === id).agent_family, 'OpenAI', 'listAgents returns it');
});

test('[V4,B26,H16] default vendor aliases refuse codex and openai reviewers in both directions', t => {
  for (const [builder, reviewer] of [['core-1', 'core-6'], ['core-6', 'core-4']]) {
    const f = fixture(t);
    joinSeat(f.board, 'core-6', ' OpenAI ', '6');
    const id = f.add(), item = f.submit(id, builder);
    assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).ineligible.some(row => row.agent === reviewer && row.code === 'SAME_FAMILY'));
    assert.throws(() => f.reserve(id, reviewer), { code: 'SAME_FAMILY' });
    assert.equal(store.nextFor(f.board, { agentId: reviewer, lane: 'core', verify: true, familyPolicy: 'require' }).item, null);
    assert.throws(() => store.verify(f.board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Synthetic family comparison.',
      head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'require', check: 'none' }), { code: 'SAME_FAMILY' });
  }
});

test('[V4,B26] unknown declared families remain distinct and missing families name the join recovery', t => {
  const f = fixture(t);
  joinSeat(f.board, 'core-6', ' Future Vendor A ', '6');
  joinSeat(f.board, 'core-7', 'Future Vendor B', '7');
  const id = f.add(), item = f.submit(id, 'core-6');
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-7'));
  assert.equal(f.reserve(id, 'core-7').item_review_by, 'core-7');
  for (const sensitive of [false, true]) {
    const g = fixture(t);
    joinSeat(g.board, 'core-6', null, '6');
    const missing = g.add({ sensitive }); g.submit(missing);
    assert.throws(() => g.reserve(missing, 'core-6'), error => error.code === 'O2_FAMILY_MATCH' && /pullboard join --family/u.test(error.message) && /pullboard join --family/u.test(error.next));
  }
});

test('[V4,B26,H16] the vendor table is explicit, configuration cannot split known vendors, and old engines retain their aliases', t => {
  const f = fixture(t);
  for (const [label, vendor] of [[' GPT ', 'openai'], ['Sonnet', 'anthropic'], ['OPUS', 'anthropic'], ['haiku', 'anthropic'],
    ['Claude', 'anthropic'], ['Gemini', 'google'], ['Grok', 'xai'], ['Unknown X', 'unknown x']]) {
    assert.equal(canonicalFamily(f.board, label), vendor);
  }
  f.board.familyAliases = familyIndex({ custom: ['codex'], claude: ['custom-claude'] });
  assert.equal(canonicalFamily(f.board, 'codex'), 'openai');
  assert.equal(canonicalFamily(f.board, 'custom-claude'), 'anthropic');
  f.board.executionEngineVersion = VENDOR_FAMILY_ENGINE - 1;
  assert.equal(canonicalFamily(f.board, 'codex'), 'custom');
  assert.equal(canonicalFamily(f.board, 'Claude'), 'claude');
});

for (const [builderFamily, reviewerFamily] of [['openai', 'OpenAI'], ['codex', 'openai'], ['claude', 'Claude'], ['OpenAI', 'openai']]) {
  for (const requireFamilies of [true, false]) {
    test(`[V4,B26,H16] ${builderFamily} builder and ${reviewerFamily} reviewer are one vendor on every eligibility path (require ${requireFamilies})`, t => {
      const f = fixture(t, { requireFamilies });
      joinSeat(f.board, 'core-6', builderFamily, '6');
      joinSeat(f.board, 'core-7', reviewerFamily, '7');
      const id = f.add(), item = f.submit(id, 'core-6');
      const view = reviewEligibility(f.board, item, { familyPolicy: 'require' });
      assert.equal(view.eligible.includes('core-7'), false, 'show lists no same-vendor reviewer');
      assert.ok(view.ineligible.some(row => row.agent === 'core-7' && row.code === 'SAME_FAMILY'));
      assert.throws(() => f.reserve(id, 'core-7'), { code: 'SAME_FAMILY' });
      assert.equal(store.nextFor(f.board, { agentId: 'core-7', lane: 'core', verify: true, familyPolicy: 'require' }).item, null);
      assert.throws(() => store.verify(f.board, id, { agentId: 'core-7', decision: 'ACCEPT', note: 'Synthetic family comparison.',
        head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'require', check: 'none' }), { code: 'SAME_FAMILY' });
    });
  }
}

import { SAME_FAMILY_REFUSAL_ENGINE } from '../../../../../packages/state/light.js';

test('same-vendor refusal keeps its historical code before the new engine [V4,B26,H16]', t => {
  const f = fixture(t);
  joinSeat(f.board, 'core-6', 'OpenAI', '6');
  const id = f.add();
  f.submit(id, 'core-1');
  f.board.executionEngineVersion = SAME_FAMILY_REFUSAL_ENGINE - 1;
  assert.throws(() => f.reserve(id, 'core-6'), { code: 'O2_FAMILY_MATCH' });
});

test('next reports the same-vendor skip before reserving an eligible review [V4,B26,C7]', t => {
  const f = fixture(t), same = f.add(), eligible = f.add();
  f.submit(same, 'core-2'); f.submit(eligible, 'core-1');
  const result = store.reserveNextReview(f.board, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'require' });
  assert.equal(result.item.item_id, eligible);
  assert.equal(result.item.item_review_by, 'core-5');
  assert.ok(result.reasons.includes('skipped 1 submitted review this seat cannot render'));
  assert.ok(result.reasons.some(reason => reason.startsWith('1 SAME_FAMILY:')));
  assert.equal(store.getItem(f.board, same).item_review_by, null, 'the skipped item has no reservation');
});

test('next counts every ineligible review when no declared seat has the required vendor [V4,B26,C7]', t => {
  const f = fixture(t), first = f.add({ reviewFamily: 'google' }), second = f.add({ reviewFamily: 'xai' });
  f.submit(first); f.submit(second);
  for (const id of [first, second]) assert.deepEqual(reviewEligibility(f.board, store.getItem(f.board, id), { familyPolicy: 'require' }).eligible, []);
  const before = store.events(f.board);
  const result = store.reserveNextReview(f.board, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'require' });
  assert.equal(result.item, null);
  assert.ok(result.reasons.includes('skipped 2 submitted reviews this seat cannot render'));
  assert.ok(result.reasons.some(reason => reason.startsWith('1 REQUIRED_REVIEW_FAMILY:') && reason.includes(`#${first} requires reviewer family google`)));
  assert.ok(result.reasons.some(reason => reason.startsWith('1 REQUIRED_REVIEW_FAMILY:') && reason.includes(`#${second} requires reviewer family xai`)));
  assert.deepEqual(store.events(f.board), before, 'an empty eligible queue appends no reservation');
});
