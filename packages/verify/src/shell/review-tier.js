import { STRICT_RENAME_ENGINE } from '../../../../src/strict-rename-engine.js';
/** Deterministic classification uses native submitted paths, never prose or receiver files [V4,B26,H16]. */
import { REVIEW_DEFAULT_ENGINE } from '../../../../src/review-default-engine.js';
import { REVIEW_TIER_ENGINE } from '../../../../src/review-tier-engine.js';
import { ENGINE_VERSION } from '../../../../src/engine-metadata.js';
import { itemPatches } from '../../../items/core.js';
import { itemPatchPaths } from '../../../items/core.js';
import { outsideSource } from '../../../items/core.js';

// Rulings 39301/39401: source areas and named guard tests, never all test/board/review/person families.
const SOURCE_DIRECTORIES = ['relay/', 'src/gate/', 'src/auth/', 'src/relay/', 'src/kernel/', 'src/landing/', 'src/runner/',
  'bin/checks/', '.githooks/', '.husky/', '.github/workflows/'];
const SOURCE_FAMILIES = ['gate', 'landing', 'runner', 'relay'];
const SOURCE_FILES = new Set([
  // Preserve the strict tier of the exact moved relay workers (#1591).
  'apps/lib/src/shell/relay-checkpoint-worker.js',
  'apps/lib/src/shell/relay-sender-main.js',
  // Exact store identities retain Strict after both cells move (#1570).
  'packages/store/src/core/known-main-reworks.js',
  'packages/store/src/shell/proof-receipts.js',
  // Exact moved verify bodies retain their original Strict classification, including this module itself (#1568).
  'packages/verify/src/core/required-review-family.js',
  'packages/verify/src/core/review-eligibility.js',
  'packages/verify/src/shell/review-independence.js',
  'packages/verify/src/core/review-policy.js',
  'packages/verify/src/shell/review-routing.js',
  'packages/verify/src/core/source-advance-state.js',
  'packages/verify/src/shell/verdict-admission.js',
  'packages/verify/src/core/verdict-assurance.js',
  'packages/verify/src/shell/verdict-freshness.js',
  'packages/verify/src/core/verdict-reviews.js',
  'packages/verify/src/shell/verdict-trunk.js',
  'packages/verify/src/shell/verdict-withdrawal.js',
  'packages/verify/src/shell/review-tier.js',
  // Exact sensitive merge bodies retain their original Strict classification (#1566).
  'packages/merge/src/shell/merge-only-verdict.js',
  'packages/merge/src/shell/train-mechanical-merge.js',
  // Exact moved move bodies retain their existing Strict classification (#1583).
  'packages/moves/src/core/moves/reserveReview.js', 'packages/moves/src/core/moves/reserveNextReview.js',
  'packages/moves/src/core/moves/verify.js', 'packages/moves/src/core/moves/submit.js',
  'packages/moves/src/shell/move-registry.js',
  // Exact moved flake bodies retain their existing Strict classification (#1587).
  'packages/flakes/src/shell/flakes.js', 'packages/flakes/src/shell/native-flake-cli.js',
  'packages/flakes/src/shell/native-flakes.js', 'packages/flakes/src/shell/quarantine.js',
  // Exact moved identities retain their existing Strict classification (#1565).
  'packages/items/src/shell/parent-session.js',
  'packages/items/src/shell/item-patches.js',
  'packages/items/src/shell/item-patch-state.js',
  'packages/items/src/shell/item-patch-compose.js',
  'packages/items/src/core/item-patch-paths.js',
  'packages/items/src/shell/item-authors.js',
  'package.json', 'pullboard.json', 'bin/run-tests.js',
  // Check admission, selection and the evidence that decides whether a failure blocks.
  'src/quarantine.js', 'src/flakes.js', 'src/ci-flakes.js', 'packages/github/src/shell/ci-flakes.js', 'src/native-flakes.js', 'src/native-flake-cli.js',
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
  'apps/cli/src/shell/commands/submit.js', 'apps/cli/src/shell/commands/verify.js', 'apps/cli/src/shell/commands/gate.js',
  'apps/cli/src/shell/commands/flakes.js', 'apps/cli/src/core/runner-loss-health.js',
  // Kernel replay, explicit authentication boundaries and source-bound receipt/landing checks.
  'src/machine.js', 'src/engine.js', 'src/move-registry.js', 'src/registry-guards.js',
  'src/refused.js', 'src/discovery.js', 'src/js-lex.js', 'src/literal-shell-words.js',
  'src/person.js', 'src/person-presence.js', 'src/person-signing.js', 'src/person-request.js', 'src/person-attested.js',
  'src/seal.js', 'packages/kernel/src/core/seal.js', 'src/sealed-pages.js', 'src/signature.js', 'packages/spec/src/shell/signature.js', 'src/agent-grant.js', 'src/coordinator-hold.js',
  'packages/seats/src/shell/coordinator-hold.js', 'packages/seats/src/core/seat-review-read.js', 'src/seat-review-read.js', 'src/parent-session.js', 'src/item-patches.js', 'src/item-patch-state.js',
  'src/item-patch-compose.js', 'src/item-patch-paths.js', 'src/proof-receipts.js', 'src/pre-push-receipts.js',
  'src/train-mechanical-merge.js', 'src/release-gate.js', 'src/release-gate-receipt.js',
  'src/source-advance.js', 'packages/sandbox/src/shell/source-advance.js',
  'packages/sandbox/src/shell/source-advance-worker.js', 'src/source-advance-state.js', 'src/source-advance-worker.js',
  'src/land.js', 'src/runners.js', 'packages/gate/src/shell/browser-admission.js', 'src/gui-admission.js',
  'src/runner-source-scan.js', 'src/runner-history-pack.js', 'src/runner-remote-tooling.js', 'src/runner-request.js',
  'src/runner-result.js', 'src/runner-dispatch.js', 'src/runner-health.js',
]);
// An old Standard body keeps its tier after moving under a cell the area rule would otherwise raise to Strict (#1574).
const STANDARD_MOVED = new Set(['packages/link/src/shell/command-phase.js']);
const GUARD_TESTS = new Set([
  'packages/store/tests/verdict-check.test.js',
  // Exact moved gate guard tests retain their Strict classification (#1577).
  'packages/gate/tests/check.test.js', 'packages/gate/tests/gui-admission.test.js', 'packages/gate/tests/landing-stage-composition.test.js',
  'test/flakes.test.js', 'test/flakes-ledger.test.js', 'test/affected-tests.test.js', 'test/affected-source-loads.test.js',
  'test/selection-fallbacks.test.js', 'test/run-tests.test.js', 'test/run-tests-worker-identity.test.js',
  'test/gate.test.js', 'test/gate-admission.test.js', 'test/gui-admission.test.js',
  'test/check.test.js', 'test/check-baseline.test.js', 'test/known-main-red-match.test.js',
  'test/review-tier.test.js', 'test/review-eligibility.test.js', 'test/review-reservation.test.js',
  'test/verdict-check.test.js', 'test/verdict-assurance.test.js', 'test/verdict-trunk.test.js',
  'test/machine.test.js', 'test/engine.test.js', 'test/engine-replay.test.js',
  'test/person.test.js', 'test/person-request.test.js', 'test/person-credential-vault.test.js', 'test/seal.test.js',
  'test/relay-auth-expired.test.js', 'test/relay-machine-auth.test.js', 'test/relay-agent.test.js',
  'test/relay-outbox-format.test.js', 'packages/outbox/tests/relay-outbox-format.test.js', 'test/relay-parity.test.js', 'test/relay-parity-clock.test.js',
  'test/relay-sealed.test.js', 'test/relay-key.test.js', 'test/relay-device-keys.test.js', 'test/relay-phone-crypto.test.js',
  // Exact moved link guard bodies retain their Strict classification (#1574).
  'packages/link/tests/relay-device-keys.test.js', 'packages/link/tests/relay-phone-crypto.test.js',
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
  if (STANDARD_MOVED.has(value)) return false;
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
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const renamed = engine >= STRICT_RENAME_ENGINE && board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`strict_rename:${id}`);
  if (renamed && outsideSource(board, id)?.kind !== 'pull-request') return true;
  const judgment = engine >= REVIEW_TIER_ENGINE
    && outsideSource(board, id)?.kind !== 'pull-request' && gateJudgmentItem(board, id);
  if (engine >= REVIEW_DEFAULT_ENGINE && board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get()) return false;
  return judgment;
}

/** Once a new native prefix exists, older envelopes cannot bypass the classification it activates. */
export function reviewTierFloor(board, id) {
  if (!board) return 1;
  const renamed = id === undefined ? board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key LIKE 'strict_rename:%' LIMIT 1").get() : board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`strict_rename:${id}`);
  if (renamed) return STRICT_RENAME_ENGINE;
  if (id === undefined
    ? board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get()
    : board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${id}`)) return REVIEW_DEFAULT_ENGINE;
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
