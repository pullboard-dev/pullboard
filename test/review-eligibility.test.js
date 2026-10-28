import * as queueStore from '../src/board.js';
import { eligibilityProblem as queueEligibility } from '../src/review-eligibility.js';
/** Private board-state fixtures exercise independence; synthetic commits and events are not gate proof [V4,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { REVIEW_ROUTING_ENGINE } from '../src/review-routing-engine.js';
import { reviewEligibility } from '../src/review-eligibility.js';
import { itemReviewPolicy } from '../src/review-independence.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../src/review-independence-engine.js';
import { workQueue } from '../src/queue.js';
import { exportBoard } from '../src/exchange.js';
import { importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runCliInProcess } from './cli-in-process-fixture.js';
import { prepareEngineMove } from '../src/engine.js';
import { applyEngineMove } from '../src/engine.js';
import { minimumMoveEngine } from '../src/move-registry.js';
import { familyIndex } from '../src/review-policy.js';
import { FAMILY_ALIAS_ENGINE } from '../src/family-alias-engine.js';
import { FAMILY_DECLARE_ENGINE } from '../src/family-declare-engine.js';
import { withOpenedBoard } from '../src/cli-read-context.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-bar' });

/** Declare every vendor and persisted parent explicitly; no model label supplies an inferred family. */
function fixture(t, { historical = false, requireFamilies = true } = {}) {
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
  store.release(f.board, id, 'core-2');
  const item = f.submit(id);
  assert.deepEqual(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible, ['coordinator', 'core-2', 'core-3', 'core-5']);
  assert.equal(f.reserve(id, 'core-3').item_review_by, 'core-3', 'a released claim without a commit is not Standard authorship');
});

test('one eligibility projection reads shared history once and the next sees new facts [C7,V4,B26]', t => {
  const f = fixture(t), id = f.add({ sensitive: true }), item = f.submit(id);
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

test('a strict item refuses any seat that touched it [V4,B26]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
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
  const queue = workQueue(f.board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }, 'core-5', { familyPolicy: 'require' });
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
  assert.throws(() => reserve(required, 'core-4', 'require'), { code: 'O2_FAMILY_MATCH' });
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


test('engine 142 family records retain their shape and become Strict under modern review [V4,B26,H16]', t => {
  const f = fixture(t);
  f.board.executionEngineVersion = 142;
  const id = f.add({ reviewFamily: 'ClAuDe' });
  const added = store.events(f.board).find(event => event.event_kind === 'add' && event.item_id === id);
  assert.equal(JSON.parse(added.event_detail).reviewFamily, 'ClAuDe');
  assert.equal(Object.hasOwn(JSON.parse(added.event_detail), 'reviewPolicy'), false, 'sealed legacy add retains its native event shape');
  store.editItem(f.board, id, { agentId: 'coordinator', reviewFamily: 'CLAUDE' });
  const edited = store.events(f.board).filter(event => event.event_kind === 'edit' && event.item_id === id).at(-1);
  assert.equal(JSON.parse(edited.event_detail).reviewFamily, 'CLAUDE');
  assert.equal(Object.hasOwn(JSON.parse(edited.event_detail), 'reviewPolicy'), false);
  delete f.board.executionEngineVersion;
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


test('modern Strict policy fences old-engine reserve, selection and verdict replay [V4,B26,H16]', t => {
  for (const policy of [{ sensitive: true }, { reviewFamily: 'claude' }]) {
    for (const operation of ['reserveReview', 'reserveNextReview', 'verify']) {
      const f = fixture(t), id = f.add(policy);
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


test('ordered activation protects legacy family items and preserves genuine engine 142 receipts [V4,B26,H16]', t => {
  for (const activation of ['success', 'refusal']) {
  const f = fixture(t, { historical: true });
  f.board.clock = { now: () => new Date('2026-10-27T00:02:00.000Z') };
  const id = f.add({ reviewFamily: 'claude' });
  store.appendFact(f.board, id, { agentId: 'core-2', kind: 'note', text: 'Historical item write becomes a Strict touch after rollout.' });
  f.submit(id);
  delete f.board.executionEngineVersion;
  const args = [id, { agentId: 'core-5', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' }];
  const old = { ...prepareEngineMove(f.board, 'reserveReview', args, { id: 'genuine-142-review' }), engine: 142 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
  assert.equal(first.error, undefined, 'real historical 142 reservation is accepted before activation');
  const receipt = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value;
  store.release(f.board, id, 'core-5', 'Release the historical reservation before the rollout control.');
  const modern = activation === 'success'
    ? prepareEngineMove(f.board, 'appendFact', [id, { agentId: 'core-2', kind: 'note', text: 'Modern recorded native mutation activates review semantics.' }], { id: 'activate-review-prefix' })
    : prepareEngineMove(f.board, 'reserveReview', [id, { ...args[1], agentId: 'core-3' }], { id: 'activate-refusal-prefix' });
  const activated = applyEngineMove(f.board, modern, { sequence: 2, at: '2026-10-27T00:02:00.000Z' });
  assert.equal(activated.error?.code, activation === 'success' ? undefined : 'STRICT_REVIEW_TOUCHED');
  const newArgs = [id, { ...args[1], agentId: 'core-3' }];
  const next = prepareEngineMove(f.board, 'reserveReview', newArgs, { id: 'new-review-old-item' });
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
      assert.equal(eligibility.ineligible.find(entry => entry.agent === 'core-4').code, 'O2_FAMILY_MATCH');
      const before = exportBoard(f.board);
      assert.throws(() => store.reserveReview(f.board, id, options), { code: 'O2_FAMILY_MATCH' });
      assert.deepEqual(exportBoard(f.board), before, 'refusal changes no native state');
      assert.equal(store.reserveReview(f.board, id, { ...options, agentId: 'core-5' }).item_review_by, 'core-5');
    }
  }
});



test('routing activation fences vendor-rule downgrades while genuine historical receipts replay unchanged [C7,V4,B26,H16]', t => {
  for (const operation of ['reserveReview', 'reserveNextReview', 'verify']) {
    const f = fixture(t, { requireFamilies: false });
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
    store.release(f.board, id, 'core-4', 'Release the historical review before routing activation.');
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
      operation === 'reserveNextReview' ? null : 'O2_FAMILY_MATCH');
    const replayBefore = exportBoard(f.board);
    assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' }), first);
    assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`relay_receipt_${old.id}`).meta_value, receipt);
    assert.deepEqual(exportBoard(f.board), replayBefore, 'genuine old receipt keeps its exact outcome and bytes');
  }
});

test('an explicit alias makes one vendor one family, while a true cross-family reviewer stays eligible [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add();
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/core-6', family: 'OpenAI', parentDigest: 'f'.repeat(64), model: 'Synthetic fixture model' });
  const item = f.submit(id);
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), 'without an alias, OpenAI and codex are distinct spellings');
  f.board.familyAliases = familyIndex({ openai: ['codex'] });
  const projected = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.equal(projected.eligible.includes('core-6'), false, 'an aliased spelling of the builder family is the same vendor');
  assert.ok(projected.ineligible.some(row => row.agent === 'core-6' && row.code === 'O2_FAMILY_MATCH'));
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
  assert.ok(projected.ineligible.some(row => row.agent === 'core-6' && row.code === 'O2_FAMILY_MATCH'));
});

/** Register one extra seat with a declared vendor family and its own persisted parent session. */
function joinSeat(board, id, family, parent) {
  store.register(board, { id, lane: 'core', path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
}

test('a companion patch author of another spelling blocks that vendor from reviewing a strict item [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  joinSeat(f.board, 'core-6', 'OpenAI', '6');
  joinSeat(f.board, 'core-7', 'gemini', '7');
  const item = f.submit(id, 'core-2');
  const author = { agentId: 'core-1', parentSession: null, session: null };
  f.board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`item_patches:${id}`,
    JSON.stringify({ version: 1, patches: [{ key: 'companion', commit: 'c'.repeat(40), digest: 'd'.repeat(64), active: true, author }] }));
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), 'without an alias, OpenAI is not the codex companion family');
  f.board.familyAliases = familyIndex({ openai: ['codex'] });
  const projected = reviewEligibility(f.board, item, { familyPolicy: 'require' });
  assert.equal(projected.eligible.includes('core-6'), false, 'the companion author is codex, which the alias list says is OpenAI');
  assert.ok(projected.ineligible.some(row => row.agent === 'core-6' && row.code === 'O2_FAMILY_MATCH'));
  assert.ok(projected.ineligible.some(row => row.agent === 'core-1'), 'the companion author is itself excluded');
  assert.ok(projected.eligible.includes('core-7'), 'a third vendor remains eligible');
  assert.throws(() => f.reserve(id, 'core-6'), { code: 'O2_FAMILY_MATCH' });
});

test('the real withOpenedBoard installs the alias list from accepted main and the projection keeps it [V4,B26]', t => {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, families: { openai: ['codex'] } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: declare vendor aliases');
  // The opener closes its board, so this one is not also closed by a test hook.
  const f = fixture({ after() {} }), id = f.add();
  joinSeat(f.board, 'core-6', 'OpenAI', '6');
  const item = f.submit(id);
  assert.ok(reviewEligibility(f.board, item, { familyPolicy: 'require' }).eligible.includes('core-6'), 'before opening, no alias index exists');
  const eligible = withOpenedBoard({ info: { root: box.repo, isMain: true }, io: {} }, board => reviewEligibility(board, item, { familyPolicy: 'require' }), f.board);
  assert.equal(eligible.eligible.includes('core-6'), false, 'an alias committed on main reaches the review projection through the production opener');
  assert.ok(eligible.eligible.includes('core-2'));
});

test('aliases and the strict builder rule apply only from their engine; an older sealed move replays unchanged [C7,V4,B26,H16]', t => {
  const f = fixture(t, { requireFamilies: false });
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
  store.release(f.board, id, 'core-6', 'Release the historical review before the alias engine applies.');
  f.board.clock = { now: () => new Date('2026-10-28T01:03:00.000Z') };
  const fresh = prepareEngineMove(f.board, 'reserveReview', [id, options]);
  assert.equal(applyEngineMove(f.board, fresh, { sequence: 2, at: '2026-10-28T01:04:00.000Z' }).error?.code, 'O2_FAMILY_MATCH', 'the current engine applies the alias');
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
  assert.ok(current.ineligible.some(row => row.agent === 'core-9' && row.code === 'O2_FAMILY_MATCH'));
  assert.throws(() => store.reserveReview(f.board, id, options), { code: 'O2_FAMILY_MATCH' });
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
  assert.throws(() => again('OpenAI'), error => error.code === 'PARENT_SESSION_CHANGED', 'a declared seat is refused a change from another session');
  assert.equal(f.board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('core-7').agent_family, 'Anthropic', 'a refused declaration changes nothing');
});

test('a declared alias spelling is the builder\'s vendor, so that seat still cannot review [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add({ sensitive: true });
  f.board.familyAliases = familyIndex({ claude: ['claude-family'] });
  const seat = { id: 'core-9', lane: 'core', path: '/fixture/core-9', model: 'Synthetic fixture model' };
  store.register(f.board, { ...seat, parentDigest: '7'.repeat(64) });
  f.submit(id, 'core-2');
  store.register(f.board, { ...seat, family: 'claude-family', parentDigest: '9'.repeat(64) });
  assert.throws(() => f.reserve(id, 'core-9'), error => error.code === 'O2_FAMILY_MATCH', 'the declared name goes through the alias list');
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

test('the one-time family declaration applies only from its engine; an older engine keeps the session refusal [C7,V4,B26,H16]', t => {
  const f = fixture(t);
  f.board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  const seat = { id: 'core-8', lane: 'core', path: '/fixture/core-8', model: 'Synthetic fixture model' };
  store.register(f.board, { ...seat, parentDigest: '8'.repeat(64) });
  assert.throws(() => store.register(f.board, { ...seat, family: 'Anthropic', parentDigest: '9'.repeat(64) }), error => error.code === 'PARENT_SESSION_CHANGED');
});
