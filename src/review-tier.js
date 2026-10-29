/** Deterministic classification uses native submitted paths, never prose or receiver files [V4,B26,H16]. */
import { REVIEW_TIER_ENGINE } from './review-tier-engine.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { itemPatches } from './item-patch-state.js';
import { itemPatchPaths } from './item-patch-paths.js';
import { outsideSource } from './outside-source.js';

// Rulings 39301/39401: source areas and named guard tests, never all test/board/review/person families.
const SOURCE_DIRECTORIES = ['relay/', 'src/gate/', 'src/auth/', 'src/relay/', 'src/kernel/', 'src/landing/', 'src/runner/',
  'bin/checks/', '.githooks/', '.husky/', '.github/workflows/'];
const SOURCE_FAMILIES = ['gate', 'landing', 'runner', 'relay'];
const SOURCE_FILES = new Set([
  'package.json', 'pullboard.json', 'bin/run-tests.js',
  // Check admission, selection and the evidence that decides whether a failure blocks.
  'src/quarantine.js', 'src/flakes.js', 'src/ci-flakes.js', 'src/native-flakes.js', 'src/native-flake-cli.js',
  'src/affected-tests.js', 'src/test-selection.js', 'src/test-result-store.js', 'src/test-file-dispatch.js',
  'src/test-run.js', 'src/test-file-pool.js', 'src/test-isolation.js', 'src/test-action-cache.js',
  'src/test-action-transfer.js', 'src/test-placement.js', 'src/module-imports.js',
  'src/submit-admission.js', 'src/check-mask.js', 'src/check-baseline.js', 'src/check-baseline-worker.js',
  'src/known-main-reworks.js', 'src/known-main-failures.js', 'src/main-failure-matches.js',
  // These specific review modules judge authority/results; presentation and queue families stay Standard.
  'src/review-policy.js', 'src/review-tier.js', 'src/review-independence.js', 'src/review-routing.js',
  'src/review-eligibility.js', 'src/required-review-family.js', 'src/item-authors.js',
  'src/verdict-admission.js', 'src/verdict-assurance.js', 'src/verdict-freshness.js', 'src/verdict-reviews.js',
  'src/verdict-trunk.js', 'src/verdict-withdrawal.js', 'src/merge-only-verdict.js',
  'src/moves/reserveReview.js', 'src/moves/reserveNextReview.js', 'src/moves/verify.js', 'src/moves/submit.js',
  'src/commands/submit.js', 'src/commands/verify.js', 'src/commands/gate.js', 'src/commands/flakes.js',
  // Kernel replay, explicit authentication boundaries and source-bound receipt/landing checks.
  'src/machine.js', 'src/engine.js', 'src/move-registry.js', 'src/registry-guards.js',
  'src/refused.js', 'src/discovery.js', 'src/js-lex.js', 'src/literal-shell-words.js',
  'src/person.js', 'src/person-presence.js', 'src/person-signing.js', 'src/person-request.js', 'src/person-attested.js',
  'src/seal.js', 'packages/kernel/src/core/seal.js', 'src/sealed-pages.js', 'src/signature.js', 'src/agent-grant.js', 'src/coordinator-hold.js',
  'src/seat-review-read.js', 'src/parent-session.js', 'src/item-patches.js', 'src/item-patch-state.js',
  'src/item-patch-compose.js', 'src/item-patch-paths.js', 'src/proof-receipts.js', 'src/pre-push-receipts.js',
  'src/train-mechanical-merge.js', 'src/release-gate.js', 'src/release-gate-receipt.js',
  'src/source-advance.js', 'src/source-advance-state.js', 'src/source-advance-worker.js',
  'src/land.js', 'src/runners.js', 'src/browser-admission.js', 'src/gui-admission.js',
  'src/runner-source-scan.js', 'src/runner-history-pack.js', 'src/runner-remote-tooling.js', 'src/runner-request.js',
  'src/runner-result.js', 'src/runner-dispatch.js', 'src/runner-health.js',
]);
const GUARD_TESTS = new Set([
  'test/flakes.test.js', 'test/flakes-ledger.test.js', 'test/affected-tests.test.js', 'test/affected-source-loads.test.js',
  'test/selection-fallbacks.test.js', 'test/run-tests.test.js', 'test/run-tests-worker-identity.test.js',
  'test/gate.test.js', 'test/gate-admission.test.js', 'test/gui-admission.test.js',
  'test/check.test.js', 'test/check-baseline.test.js', 'test/known-main-red-match.test.js',
  'test/review-tier.test.js', 'test/review-eligibility.test.js', 'test/review-reservation.test.js',
  'test/verdict-check.test.js', 'test/verdict-assurance.test.js', 'test/verdict-trunk.test.js',
  'test/machine.test.js', 'test/engine.test.js', 'test/engine-replay.test.js',
  'test/person.test.js', 'test/person-request.test.js', 'test/person-credential-vault.test.js', 'test/seal.test.js',
  'test/relay-auth-expired.test.js', 'test/relay-machine-auth.test.js', 'test/relay-agent.test.js',
  'test/relay-outbox-format.test.js', 'test/relay-parity.test.js', 'test/relay-parity-clock.test.js',
  'test/relay-sealed.test.js', 'test/relay-key.test.js', 'test/relay-device-keys.test.js', 'test/relay-phone-crypto.test.js',
  'test/landing-shards.test.js', 'test/landing-lease.test.js', 'test/landing-local-lease.test.js',
  'test/landing-waiver-replay.test.js', 'test/landing-stage-composition.test.js',
  'test/train-mechanical-merge.test.js', 'test/pre-push-receipts.test.js', 'test/land.test.js',
  'test/runner-policy.test.js', 'test/runner-invalid-spec.test.js', 'test/runner-transport-lost.test.js',
  'test/runner-stage.test.js', 'test/runner-wait-deadline.test.js',
]);

/** Match only the ruled source areas, exact judgment modules and named guard tests; other work uses the manual mark. */
export function gateJudgmentPath(path) {
  if (typeof path !== 'string') return false;
  const value = path.replace(/^\.\//u, '');
  if (/\.(?:md|mdx|rst|adoc)$/iu.test(value)) return false;
  if (SOURCE_FILES.has(value) || GUARD_TESTS.has(value)) return true;
  if (SOURCE_DIRECTORIES.some(prefix => value.startsWith(prefix))) return true;
  if (/^src\/[^/]+\.js$/u.test(value)) {
    const name = value.slice(4);
    return SOURCE_FAMILIES.some(family => name.startsWith(family + '-') || name === family + '.js');
  }
  return /^packages\/(?:gate|auth|kernel|landing|runners|keys|link|outbox)\/(?:index\.js$|src\/)/u.test(value)
    || /^apps\/(?:runner|relay)\/(?:index\.js$|src\/)/u.test(value);
}

/** Native submitted file inventory is replicated; titles, briefs and the reviewer's filesystem are not authority. */
export function gateJudgmentItem(board, id) {
  const files = board.db.prepare('SELECT item_files FROM item WHERE item_id=?').get(id)?.item_files ?? '';
  if (files.split('\n').some(gateJudgmentPath)) return true;
  return itemPatches(board, id).some(record => [...itemPatchPaths(record.patch)].some(gateJudgmentPath));
}

/**
 * Genuine old ordered moves keep their old tier even after an upgrade.
 *
 * An intaken outside pull request is never classified: its author has no declared vendor family, so the
 * strict vendor comparison could never pass, and its path trust is the outside regime instead (the
 * sandbox verdict plus the owner's approval of the exact commit for sensitive paths) [V3,B26].
 */
export function classifiedStrict(board, id) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_TIER_ENGINE
    && outsideSource(board, id)?.kind !== 'pull-request' && gateJudgmentItem(board, id);
}

/** Once a new native prefix exists, older envelopes cannot bypass the classification it activates. */
export function reviewTierFloor(board, id) {
  if (!board) return 1;
  const active = board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_tier:active'").get();
  if (active) return REVIEW_TIER_ENGINE;
  const policies = id === undefined
    ? board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'review_independence:%'").all()
    : board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').all(`review_independence:${id}`);
  return policies.some(row => markedPolicy(row.meta_value)) ? REVIEW_TIER_ENGINE : 1;
}

/** Malformed policy is never an invitation to use an older engine; the policy reader supplies its typed refusal. */
function markedPolicy(text) {
  try { return JSON.parse(text).reviewTier === 'strict'; }
  catch { return true; }
}
