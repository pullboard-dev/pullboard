/** Synthetic native board moves test classification and guard composition; they are not gate receipts [V4,B26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealStrictRenames } from '../packages/store/index.js';
import { STRICT_RENAME_ENGINE } from '../packages/state/index.js';
import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { gateJudgmentPath } from '../packages/verify/index.js';
import { itemReviewPolicy } from '../packages/verify/index.js';
import { reviewEligibility } from '../packages/verify/index.js';
import { REVIEW_TIER_ENGINE } from '../src/review-tier-engine.js';
import {
  prepareEngineMove,
  applyEngineMove,
} from '../packages/state/index.js';
import { minimumMoveEngine } from '../packages/moves/index.js';
import {
  exportBoard,
  importBoard,
} from '../packages/store/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runCliInProcess } from './cli-in-process-fixture.js';

const LEASE = 3_600_000;

/** Real production board guards receive explicit synthetic identities, source inventories and lifecycle records. */
function fixture(t, { historical = false } = {}) {
  const board = fixtureBoard(t);
  // These original classification contracts replay the engine that introduced automatic Strict.
  // Current explicit-only defaults and their migration have their own native contract suite.
  if (historical) board.executionEngineVersion = REVIEW_TIER_ENGINE;
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

test('ruled judgment areas and named guard tests are Strict while broad product families are Standard [V4,B26]', () => {
  for (const path of ['src/quarantine.js', 'src/flakes.js', 'src/ci-flakes.js', 'packages/github/src/shell/ci-flakes.js', 'src/test-result-store.js',
    'src/affected-tests.js', 'src/test-selection.js', 'src/submit-admission.js', 'src/known-main-reworks.js',
    'src/review-eligibility.js', 'src/verdict-admission.js', 'src/landing-test-policy.js', 'src/runner-worker.js',
    'src/train-mechanical-merge.js', 'src/pre-push-receipts.js', 'src/gate-run-receipt.js',
    'src/moves/reserveReview.js', 'src/commands/submit.js', 'src/commands/verify.js',
    'src/relay-key.js', 'packages/kernel/src/core/seal.js', 'src/source-advance.js', 'src/source-advance-worker.js',
    'packages/spec/src/shell/signature.js',
    'packages/sandbox/src/shell/source-advance.js', 'packages/sandbox/src/shell/source-advance-worker.js',
    'src/coordinator-hold.js', 'src/seat-review-read.js',
    'packages/seats/src/shell/coordinator-hold.js', 'packages/seats/src/core/seat-review-read.js', 'src/check-mask.js', 'src/person-presence.js', 'src/person-signing.js', 'src/discovery.js', 'src/machine.js',
    'test/person.test.js', 'test/check.test.js', 'test/flakes-ledger.test.js', 'test/review-tier.test.js', 'test/selection-fallbacks.test.js',
    'test/relay-auth-expired.test.js', 'test/engine.test.js', 'test/landing-shards.test.js',
    'packages/gate/src/core/test-selection.js', 'packages/gate/src/shell/gate-run-receipt.js', 'packages/gate/src/shell/test-selection.js',
    'packages/gate/tests/check.test.js', 'packages/gate/tests/gui-admission.test.js', 'packages/gate/tests/landing-stage-composition.test.js', 'bin/run-tests.js', 'bin/checks/test-names.js',
    '.github/workflows/ci.yml', 'pullboard.json']) assert.equal(gateJudgmentPath(path), true, path);
  assert.equal(gateJudgmentPath('packages/github/src/shell/pr-github.js'), false, 'no widening to the other github modules');
  for (const path of ['docs/gate.md', 'README.md', 'relay/README.md', 'packages/gate/README.md',
    'packages/sandbox/src/shell/trusted-policy.js', 'packages/sandbox/src/shell/source-advance-origin.js',
    'packages/seats/src/core/seat-address.js', 'packages/seats/src/shell/lanes.js', 'packages/seats/src/core/verdict-rows.js', 'src/view/projector.js', 'src/help/gate.js', 'src/gateway-display.js', 'test/cockpit/detail-model.test.js',
    'src/test-value.js', 'src/test-economics.js', 'src/board.js', 'src/board-query.js',
    'src/review-queue-line.js', 'src/person-signing-words.js',
    'src/check-words.js', 'src/line-settings.js', 'src/cli-main.js',
    'src/spec.js', 'src/queue.js', 'src/moves/appendFact.js', 'bin/cells-plan.js',
    'packages/spec/src/shell/spec.js',
    'test/board.test.js', 'test/review-queue.test.js', 'test/person-trusted-cli.js', 'test/test-value.test.js',
    'test/runner-new-unlisted.test.js', 'test/project.test.js', 'packages/gate/tests/new-unlisted.test.js', 'packages/gate/tests/resources.test.js', 'packages/gate/tests/gate-resource.test.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
  }
});

test('quarantine inventory drives show eligibility and next without relaxing author, session or vendor exclusions [V4,B26]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
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

test('Git renames preserve built-in and configured sensitive tiers with an unrelated control [V4,B26,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  for (const folder of ['src', 'data', 'lib']) mkdirSync(join(box.repo, folder), { recursive: true });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.intake = { sensitivePaths: ['data/private.json'] };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(join(box.repo, 'src/quarantine.js'), 'export const boundary = true;\n');
  writeFileSync(join(box.repo, 'data/private.json'), '{"private":true}\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: declare private boundaries');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.repo, 'mv', 'src/quarantine.js', 'lib/renamed.js');
  box.git(box.repo, 'mv', 'data/private.json', 'lib/renamed.json');
  writeFileSync(join(box.repo, 'lib/unrelated.js'), 'export const unrelated = 42;\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: rename boundaries');
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const f = fixture(t), id = f.add();
  store.claim(f.board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, head: base,
    freeze: () => ({ text: '{}', digest: 'rename-git-fixture' }) });
  f.board.gitRoot = box.repo;
  const witness = sealStrictRenames(f.board, id, { commit });
  assert.deepEqual(witness.strictRenames, [['data/private.json', 'lib/renamed.json'], ['src/quarantine.js', 'lib/renamed.js']]);
  delete f.board.gitRoot;
  submitFixture(f.board, id, { agentId: 'core-1', commit, tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'),
    files: ['lib/renamed.js', 'lib/renamed.json', 'lib/unrelated.js'], strictRenames: witness.strictRenames });
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  for (const pair of witness.strictRenames) {
    const renamed = f.add();
    store.claim(f.board, renamed, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
      freeze: () => ({ text: '{}', digest: 'rename-policy-fixture' }) });
    submitFixture(f.board, renamed, { agentId: 'core-1', commit, tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), files: [pair[1]], strictRenames: [pair] });
    assert.equal(itemReviewPolicy(f.board, renamed).tier, 'strict', pair[0]);
    assert.equal(minimumMoveEngine('reserveReview', [renamed, { agentId: 'core-3', leaseMs: LEASE, policy: 'any' }], f.board), STRICT_RENAME_ENGINE);
  }
  const ordinary = f.add();
  f.submit(ordinary, ['lib/unrelated.js']);
  assert.equal(itemReviewPolicy(f.board, ordinary).tier, 'standard', 'a new unrelated file gains no inherited tier');
});

test('a sealed strict rename remains strict under the modern review default [V4,B26,H16]', t => {
  const f = fixture(t), id = f.add();
  store.claim(f.board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE,
    freeze: () => ({ text: JSON.stringify({ policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'synthetic-rename-bar' }) });
  submitFixture(f.board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    files: ['src/quarantine.js', 'lib/moved.js'], strictRenames: [['src/quarantine.js', 'lib/moved.js']] });
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  const ordinary = f.add();
  f.submit(ordinary, ['lib/ordinary.js']);
  assert.equal(itemReviewPolicy(f.board, ordinary).tier, 'standard');
});

test('docs-only submission remains Standard with optional same-vendor review [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  const item = f.submit(id, ['README.md', 'docs/gate.md']);
  assert.equal(reviewEligibility(f.board, item).tier, 'standard');
  assert.equal(f.reserve(id, 'core-2').item_review_by, 'core-2');
});

test('ordinary board, review, person and test-family work permits Standard same-vendor review [V4,B26]', t => {
  const f = fixture(t), id = f.add();
  const item = f.submit(id, ['src/board.js', 'src/board-query.js', 'src/review-queue-line.js',
    'src/person-signing-words.js', 'src/test-value.js', 'test/board.test.js', 'test/review-queue.test.js']);
  assert.equal(reviewEligibility(f.board, item).tier, 'standard');
  assert.equal(f.reserve(id, 'core-2').item_review_by, 'core-2');
});

test('an active source-bound gate companion makes docs work Strict without changing its submitted inventory [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
  const item = f.submit(id, ['README.md']);
  assert.equal(itemReviewPolicy(f.board, id).tier, 'standard');
  const patch = 'diff --git a/src/quarantine.js b/src/quarantine.js\n--- a/src/quarantine.js\n+++ b/src/quarantine.js\n@@ -1 +1 @@\n-old\n+new\n';
  store.attachItemPatch(f.board, id, { agentId: 'coordinator', key: 'gate-companion', commit: item.item_commit,
    patch, author: 'core-1' });
  assert.equal(store.getItem(f.board, id).item_files, 'README.md');
  assert.equal(itemReviewPolicy(f.board, id).tier, 'strict');
  assert.throws(() => f.reserve(id, 'core-2'), { code: 'O2_FAMILY_MATCH' });
  assert.equal(f.reserve(id, 'core-4').item_review_by, 'core-4');
});

test('unsafe companion headers refuse classification rather than silently selecting Standard [V4,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
  const item = f.submit(id, ['README.md']);
  const patch = 'diff --git a/../escape.js b/../escape.js\n--- a/../escape.js\n+++ b/../escape.js\n@@ -1 +1 @@\n-old\n+new\n';
  store.attachItemPatch(f.board, id, { agentId: 'coordinator', key: 'unsafe-companion', commit: item.item_commit,
    patch, author: 'core-1' });
  const before = exportBoard(f.board);
  assert.throws(() => f.reserve(id, 'core-4'), { code: 'ITEM_PATCH' });
  assert.deepEqual(exportBoard(f.board), before);
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
    head: after.item_commit, digest: after.item_frozen_digest, policy: 'any', familyPolicy: 'off', check: 'none' }), { code: 'SAME_FAMILY' });
  const replica = fixtureBoard(t);
  importBoard(replica, exportBoard(f.board));
  assert.deepEqual(itemReviewPolicy(replica, id), itemReviewPolicy(f.board, id));
});

test('real preactivation reservations replay unchanged and fresh lower-engine reviews cannot evade classification [V4,H16]', t => {
  const f = fixture(t, { historical: true }), id = f.add();
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


test('items move retains Strict for each protected destination and excludes unrelated siblings [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  const paths = [
    'packages/items/src/shell/parent-session.js',
    'packages/items/src/shell/item-patches.js',
    'packages/items/src/shell/item-patch-state.js',
    'packages/items/src/shell/item-patch-compose.js',
    'packages/items/src/core/item-patch-paths.js',
    'packages/items/src/shell/item-authors.js',
  ];
  for (const path of paths) {
    assert.equal(gateJudgmentPath(path), true, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', path);
  }
  for (const path of ['packages/items/src/shell/parent-session-notes.js',
    'packages/items/src/core/item-patch-paths-extra.js', 'packages/items/src/core/brief.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('moves move retains Strict for each protected body and excludes unrelated siblings [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  for (const [old, moved] of [['src/moves/reserveReview.js', 'packages/moves/src/core/moves/reserveReview.js'],
    ['src/moves/reserveNextReview.js', 'packages/moves/src/core/moves/reserveNextReview.js'],
    ['src/moves/verify.js', 'packages/moves/src/core/moves/verify.js'],
    ['src/moves/submit.js', 'packages/moves/src/core/moves/submit.js'],
    ['src/move-registry.js', 'packages/moves/src/shell/move-registry.js']]) {
    assert.equal(gateJudgmentPath(old), true, old);
    assert.equal(gateJudgmentPath(moved), gateJudgmentPath(old), moved);
    const item = f.submit(f.add(), [moved]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', moved);
  }
  for (const path of ['packages/moves/src/core/moves/reserveReviewExtra.js', 'packages/moves/src/core/moves/addItem.js',
    'packages/moves/src/core/bar-ready-setting.js', 'packages/moves/src/shell/moves/recordUsage.js', 'packages/moves/index.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('flakes move retains Strict for each protected body and excludes unrelated siblings [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  for (const name of ['flakes', 'native-flake-cli', 'native-flakes', 'quarantine']) {
    const moved = `packages/flakes/src/shell/${name}.js`;
    assert.equal(gateJudgmentPath(`src/${name}.js`), true, name);
    assert.equal(gateJudgmentPath(moved), true, moved);
    const item = f.submit(f.add(), [moved]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', moved);
  }
  for (const path of ['packages/flakes/src/shell/flake-command.js', 'packages/flakes/src/shell/native-flake-receipts.js',
    'packages/flakes/src/shell/quarantine-extra.js', 'packages/flakes/index.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('merge move retains Strict for sensitive bodies and excludes unrelated siblings [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  for (const path of ['packages/merge/src/shell/merge-only-verdict.js',
    'packages/merge/src/shell/train-mechanical-merge.js']) {
    assert.equal(gateJudgmentPath(path), true, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', path);
  }
  for (const path of ['packages/merge/src/shell/merge-only-verdict-extra.js',
    'packages/merge/src/shell/train-mechanical-merge-extra.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('verify move retains Strict for each protected destination and excludes unrelated siblings [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  for (const path of ["packages/verify/src/core/required-review-family.js","packages/verify/src/core/review-eligibility.js","packages/verify/src/shell/review-independence.js","packages/verify/src/core/review-policy.js","packages/verify/src/shell/review-routing.js","packages/verify/src/core/source-advance-state.js","packages/verify/src/shell/verdict-admission.js","packages/verify/src/core/verdict-assurance.js","packages/verify/src/shell/verdict-freshness.js","packages/verify/src/core/verdict-reviews.js","packages/verify/src/shell/verdict-trunk.js","packages/verify/src/shell/verdict-withdrawal.js","packages/verify/src/shell/review-tier.js"]) {
    assert.equal(gateJudgmentPath(path), true, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', path);
  }
  for (const path of ['packages/verify/src/core/bar-check.js', 'packages/verify/src/shell/review-tier-extra.js',
    'packages/verify/src/core/review-policy-extra.js', 'packages/verify/src/shell/verdict-trunk-extra.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('runners move preserves strict tier for every previously strict body [V4,B26,H16]', () => {
  const paths = JSON.parse(readFileSync(new URL('../bin/cells-plan/path-map/runners.json', import.meta.url), 'utf8'));
  for (const [oldPath, movedPath] of Object.entries(paths)) {
    if (gateJudgmentPath(oldPath)) assert.equal(gateJudgmentPath(movedPath), true, movedPath);
  }
  assert.equal(gateJudgmentPath('packages/runners/tests/unrelated.test.js'), false);
});

test('outbox move keeps the format guard strict without broadening test paths [V4,B26,H16]', () => {
  assert.equal(gateJudgmentPath('test/relay-outbox-format.test.js'), true);
  assert.equal(gateJudgmentPath('packages/outbox/tests/relay-outbox-format.test.js'), true);
  assert.equal(gateJudgmentPath('packages/outbox/tests/relay-outbox-format-extra.test.js'), false);
});


test('link move retains Strict for moved guard tests and keeps the Standard command phase Standard [V4,B26,H16]', t => {
  const f = fixture(t, { historical: true });
  for (const path of ['packages/link/tests/relay-device-keys.test.js', 'packages/link/tests/relay-phone-crypto.test.js',
    'packages/link/src/shell/relay-lock.js']) {
    assert.equal(gateJudgmentPath(path), true, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'strict', path);
  }
  for (const path of ['packages/link/src/shell/command-phase.js', 'packages/link/tests/relay-lock.test.js',
    'packages/link/tests/relay-device-keys-extra.test.js']) {
    assert.equal(gateJudgmentPath(path), false, path);
    const item = f.submit(f.add(), [path]);
    assert.equal(itemReviewPolicy(f.board, item.item_id).tier, 'standard', path);
  }
});


test('landing move preserves Strict on every protected provider [V4,B26,C7]', () => {
  for (const [old, moved] of [
  [
    "src/land.js",
    "packages/landing/src/shell/land.js"
  ],
  [
    "src/landing-batch-history.js",
    "packages/landing/src/core/landing-batch-history.js"
  ],
  [
    "src/landing-cadence.js",
    "packages/landing/src/core/landing-cadence.js"
  ],
  [
    "src/landing-candidates.js",
    "packages/landing/src/shell/landing-candidates.js"
  ],
  [
    "src/landing-deferred-run.js",
    "packages/landing/src/shell/landing-deferred-run.js"
  ],
  [
    "src/landing-doctrine.js",
    "packages/landing/src/shell/landing-doctrine.js"
  ],
  [
    "src/landing-environment-guards.js",
    "packages/landing/src/core/landing-environment-guards.js"
  ],
  [
    "src/landing-failure-report.js",
    "packages/landing/src/core/landing-failure-report.js"
  ],
  [
    "src/landing-host.js",
    "packages/landing/src/shell/landing-host.js"
  ],
  [
    "src/landing-main-notices.js",
    "packages/landing/src/core/landing-main-notices.js"
  ],
  [
    "src/landing-message.js",
    "packages/landing/src/core/landing-message.js"
  ],
  [
    "src/landing-resource.js",
    "packages/landing/src/shell/landing-resource.js"
  ],
  [
    "src/landing-shards.js",
    "packages/landing/src/shell/landing-shards.js"
  ],
  [
    "src/landing-test-policy.js",
    "packages/landing/src/shell/landing-test-policy.js"
  ],
  [
    "src/landing-waivers.js",
    "packages/landing/src/core/landing-waivers.js"
  ],
  [
    "src/landing-worker-identity.js",
    "packages/landing/src/core/landing-worker-identity.js"
  ],
  [
    "src/landing-worker.js",
    "packages/landing/src/shell/landing-worker.js"
  ],
  [
    "src/landing-worktree-prune.js",
    "packages/landing/src/shell/landing-worktree-prune.js"
  ],
  [
    "src/main-failure-matches.js",
    "packages/landing/src/shell/main-failure-matches.js"
  ],
  [
    "src/landing-completion.js",
    "packages/landing/src/shell/landing-completion.js"
  ],
  [
    "src/landing-docs.js",
    "packages/landing/src/shell/landing-docs.js"
  ],
  [
    "src/landing-envelope.js",
    "packages/landing/src/core/landing-envelope.js"
  ],
  [
    "src/landing-step-selection.js",
    "packages/landing/src/shell/landing-step-selection.js"
  ],
  [
    "src/landing-step-merge.js",
    "packages/landing/src/shell/landing-step-merge.js"
  ],
  [
    "src/landing-step-failures.js",
    "packages/landing/src/shell/landing-step-failures.js"
  ],
  [
    "src/landing-step-gate.js",
    "packages/landing/src/shell/landing-step-gate.js"
  ],
  [
    "src/landing-step-diagnose.js",
    "packages/landing/src/shell/landing-step-diagnose.js"
  ],
  [
    "src/landing-step-publish.js",
    "packages/landing/src/shell/landing-step-publish.js"
  ],
  [
    "src/landing-step-trunk.js",
    "packages/landing/src/shell/landing-step-trunk.js"
  ],
  [
    "src/landing-step-parallel.js",
    "packages/landing/src/shell/landing-step-parallel.js"
  ],
  [
    "src/landing-step-batch.js",
    "packages/landing/src/shell/landing-step-batch.js"
  ],
  [
    "src/landing-history-plan.js",
    "packages/landing/src/shell/landing-history-plan.js"
  ]
]) {
    assert.equal(gateJudgmentPath(old), true, old);
    assert.equal(gateJudgmentPath(moved), true, moved);
  }
  for (const ordinary of ['packages/landing/tests/retention-prune.test.js', 'test/landing-presentation.test.js']) {
    assert.equal(gateJudgmentPath(ordinary), false, ordinary);
  }
});

test('lib move preserves exact relay worker review tiers [V4,B26]', () => {
  for (const name of ['relay-checkpoint-worker', 'relay-sender-main']) {
    assert.equal(gateJudgmentPath(`src/${name}.js`), true);
    assert.equal(gateJudgmentPath(`apps/lib/src/shell/${name}.js`), true);
  }
  assert.equal(gateJudgmentPath('apps/lib/src/shell/cli-hook-work.js'), false);
});
