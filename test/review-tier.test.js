/** Synthetic native board moves test classification and guard composition; they are not gate receipts [V4,B26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { gateJudgmentPath } from '../src/review-tier.js';
import { itemReviewPolicy } from '../src/review-policy.js';
import { reviewEligibility } from '../src/review-eligibility.js';
import { REVIEW_TIER_ENGINE } from '../src/review-tier-engine.js';
import { prepareEngineMove } from '../src/engine.js';
import { applyEngineMove } from '../src/engine.js';
import { minimumMoveEngine } from '../src/move-registry.js';
import { exportBoard } from '../src/exchange.js';
import { importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runCliInProcess } from './cli-in-process-fixture.js';

const LEASE = 3_600_000;

/** Real production board guards receive explicit synthetic identities, source inventories and lifecycle records. */
function fixture(t) {
  const board = fixtureBoard(t);
  for (const [id, family, parent] of [['coordinator', 'human', 'e'], ['core-1', 'OpenAI', 'a'],
    ['core-2', 'OpenAI', 'b'], ['core-3', 'Anthropic', 'c'], ['core-4', 'Anthropic', 'd']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
      model: 'Explicit fixture model', family, parentDigest: parent.repeat(64) });
  }
  /** The declared check names the real module test, without pretending this synthetic lifecycle ran it. */
  const add = () => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review policy fixture',
    check: 'node bin/run-tests.js test/review-tier.test.js' });
  /** Capture the submitted native source inventory through production claim and submit guards. */
  const submit = (id, files) => {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
      freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'synthetic-tier-bar' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files });
    return store.getItem(board, id);
  };
  /** Use the same native reservation writer as next --verify. */
  const reserve = (id, agentId) => store.reserveReview(board, id, { agentId, leaseMs: LEASE, policy: 'any', familyPolicy: 'off' });
  return { board, add, submit, reserve };
}

test('every gate-judgment source family is Strict while docs and unrelated view code stay Standard [V4,B26]', () => {
  for (const path of ['src/quarantine.js', 'src/flakes.js', 'src/ci-flakes.js', 'src/native-flakes.js',
    'src/test-result-store.js', 'src/affected-tests.js', 'src/test-selection.js', 'src/submit-admission.js',
    'src/tap-tests.js', 'src/runner-work-spec.js', 'src/remote-gate.js', 'src/line-capacity.js',
    'src/known-main-reworks.js', 'src/review-eligibility.js', 'src/verdict-admission.js', 'src/landing-test-policy.js',
    'src/train-mechanical-merge.js', 'src/pre-push-receipts.js', 'src/gate-run-receipt.js', 'src/proof-receipts.js',
    'src/moves/reserveReview.js', 'src/commands/submit.js', 'src/commands/verify.js', 'src/board.js',
    'test/quarantine.test.js', 'test/gate-resource.test.js', 'test/relay-auth.test.js', 'test/engine.test.js',
    'src/relay-key.js', 'src/person-signing.js', 'src/discovery.js', 'packages/gate/src/core/test-selection.js', 'bin/run-tests.js', '.github/workflows/ci.yml', 'package.json', 'pullboard.json']) {
    assert.equal(gateJudgmentPath(path), true, path);
  }
  for (const path of ['docs/gate.md', 'README.md', 'relay/README.md', 'packages/gate/README.md', 'src/view/projector.js', 'src/help/gate.js', 'src/gateway-display.js', 'test/project.test.js', 'test/cockpit/detail-model.test.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
  }
});

test('quarantine inventory drives show eligibility and next without relaxing author, session or vendor exclusions [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  store.appendFact(f.board, id, { agentId: 'core-3', kind: 'note', text: 'Synthetic native helper write counts as material participation.' });
  const item = f.submit(id, ['src/quarantine.js']);
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  const eligibility = reviewEligibility(f.board, item);
  assert.equal(eligibility.tier, 'strict');
  assert.deepEqual(eligibility.eligible, ['core-4']);
  assert.throws(() => f.reserve(id, 'core-1'), { code: 'SELF_VERIFY' });
  assert.throws(() => f.reserve(id, 'core-2'), { code: 'O2_FAMILY_MATCH' });
  assert.throws(() => f.reserve(id, 'core-3'), { code: 'STRICT_REVIEW_TOUCHED' });
  const skipped = store.reserveNextReview(f.board, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' });
  assert.equal(skipped.item, null);
  const next = store.reserveNextReview(f.board, { agentId: 'core-4', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' });
  assert.equal(next.item.item_id, id);
});

test('docs-only submission remains Standard with optional same-vendor review [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  const item = f.submit(id, ['README.md', 'docs/gate.md']);
  assert.equal(reviewEligibility(f.board, item).tier, 'standard');
  assert.equal(f.reserve(id, 'core-2').item_review_by, 'core-2');
});

test('only coordinator can mark Strict and every mark needs a reason and refuses downgrade atomically [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  for (const [change, code] of [[{ agentId: 'core-2', reviewTier: 'strict', reason: 'Risk' }, 'COORDINATOR_ONLY'],
    [{ agentId: 'coordinator', reviewTier: 'strict' }, 'BAR_REASON'],
    [{ agentId: 'coordinator', reviewTier: 'standard', reason: 'Downgrade' }, 'BAD_REVIEW_POLICY']]) {
    const before = exportBoard(f.board);
    assert.throws(() => store.editItem(f.board, id, change), { code });
    assert.deepEqual(exportBoard(f.board), before);
  }
  store.editItem(f.board, id, { agentId: 'coordinator', reviewTier: 'strict', reason: 'A new gate-policy module is not catalogued yet.' });
  store.editItem(f.board, id, { agentId: 'coordinator', sensitive: false, reviewFamily: null });
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict', 'other optional flags cannot clear the explicit mark');
  const event = store.events(f.board).find(event => event.event_kind === 'edit');
  assert.equal(JSON.parse(event.event_detail).reason, 'A new gate-policy module is not catalogued yet.');
  assert.equal(minimumMoveEngine('editItem', [id, { agentId: 'coordinator', reviewTier: 'strict', reason: 'Risk' }]), REVIEW_TIER_ENGINE);
});

test('coordinator strengthening of submitted work retains frozen proof and reservation but applies current Strict guards [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  const submitted = f.submit(id, ['src/new-policy.js']);
  f.reserve(id, 'core-2');
  const before = store.getItem(f.board, id);
  store.editItem(f.board, id, { agentId: 'coordinator', reviewTier: 'strict', reason: 'Uncatalogued judgment change.' });
  const after = store.getItem(f.board, id);
  assert.equal(after.item_frozen_digest, submitted.item_frozen_digest);
  assert.equal(after.item_frozen, submitted.item_frozen);
  assert.equal(after.item_review_by, before.item_review_by);
  assert.throws(() => store.verify(f.board, id, { agentId: 'core-2', decision: 'ACCEPT', note: 'Synthetic guard control only.',
    head: after.item_commit, digest: after.item_frozen_digest, policy: 'any', familyPolicy: 'off', check: 'none' }), { code: 'O2_FAMILY_MATCH' });
  const replica = fixtureBoard(t);
  importBoard(replica, exportBoard(f.board));
  assert.deepEqual(itemReviewPolicy(replica, id), itemReviewPolicy(f.board, id));
});

test('real preactivation reservations replay unchanged and fresh lower-engine reviews cannot evade classification [V4,H16]', t => {
  const f = fixture(t), id = f.add();
  f.board.clock = { now: () => new Date('2026-10-27T00:02:00.000Z') };
  f.board.executionEngineVersion = REVIEW_TIER_ENGINE - 1;
  f.submit(id, ['src/quarantine.js']);
  const options = { agentId: 'core-2', lane: 'core', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' };
  const old = { ...prepareEngineMove(f.board, 'reserveReview', [id, options], { id: 'genuine-pre-tier-reservation' }), engine: REVIEW_TIER_ENGINE - 1 };
  const first = applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' });
  assert.equal(first.error, undefined);
  delete f.board.executionEngineVersion;
  const activation = prepareEngineMove(f.board, 'appendFact', [id, { agentId: 'coordinator', kind: 'note', text: 'Activate the current native prefix.' }]);
  assert.equal(applyEngineMove(f.board, activation, { sequence: 2, at: '2026-10-27T00:02:00.000Z' }).error, undefined);
  const next = prepareEngineMove(f.board, 'reserveReview', [id, options]);
  const before = exportBoard(f.board);
  assert.throws(() => applyEngineMove(f.board, { ...next, engine: REVIEW_TIER_ENGINE - 1 },
    { sequence: 3, at: '2026-10-27T00:03:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(f.board), before);
  assert.deepEqual(applyEngineMove(f.board, old, { sequence: 1, at: '2026-10-27T00:01:00.000Z' }), first);
});

test('native CLI edit --review-tier strict --reason persists its policy and show tier [V4,B26,P4]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  /** Normal parser and ordered writer run inside an isolated, normally initialized fixture. */
  const run = argv => runCliInProcess(argv, { cwd: box.repo, env: box.env });
  const added = await run(['add', 'web', 'Uncatalogued policy module', '--json']);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const id = JSON.parse(added.stdout).item.item_id;
  const refused = await run(['edit', String(id), '--review-tier', 'strict', '--json']);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'BAR_REASON');
  const edited = await run(['edit', String(id), '--review-tier', 'strict', '--reason', 'Changes a new gate decision.', '--json']);
  assert.equal(edited.status, 0, edited.stderr || edited.stdout);
  const shown = await run(['show', String(id), '--json']);
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  assert.equal(JSON.parse(shown.stdout).reviewEligibility.tier, 'strict');
});
