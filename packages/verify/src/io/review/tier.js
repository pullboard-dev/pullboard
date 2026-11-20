import { ENGINE_VERSION } from '../../../../state/light.js';
import { STRICT_RENAME_ENGINE } from '../../../../state/light.js';
/** Deterministic classification uses native submitted paths, never prose or receiver files [V4,B26,H16]. */
import { REVIEW_DEFAULT_ENGINE } from '../../../../state/light.js';
import { REVIEW_TIER_ENGINE } from '../../../../state/light.js';
import { itemPatches } from '../../../../items/browser.js';
import { itemPatchPaths } from '../../../../items/browser.js';
import { outsideSource } from '../../../../items/browser.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

// Rulings 39301/39401: source areas and named guard tests, never all test/board/review/person families.
const SOURCE_DIRECTORIES = ['apps/relay/', 'src/gate/', 'src/auth/', 'src/relay/', 'src/kernel/', 'src/landing/', 'src/runner/',
  'packages/gate/src/', 'packages/auth/src/', 'packages/kernel/src/', 'packages/landing/src/', 'packages/runners/src/', 'apps/runner/src/', '.githooks/', '.husky/', '.github/workflows/'];
const SOURCE_FAMILIES = ['gate', 'landing', 'runner', 'relay'];
const SOURCE_FILES = new Set([
  // Preserve the strict tier of the exact moved relay workers (#1591).
  'apps/lib/src/io/worker/checkpoint/relay.js',
  'apps/cli/src/io/sender.js',
  // Exact store identities retain Strict after both cells move (#1570).
  'packages/store/src/logic/known/main/reworks.js',
  'packages/store/src/io/receipts.js',
  // Exact moved verify bodies retain their original Strict classification, including this module itself (#1568).
  'packages/verify/src/logic/required.js',
  'packages/verify/src/logic/review/eligibility.js',
  'packages/verify/src/io/review/independence.js',
  'packages/verify/src/logic/review/policy.js',
  'packages/verify/src/io/review/routing.js',
  'packages/verify/src/logic/advance.js',
  'packages/verify/src/io/verdict/admission.js',
  'packages/verify/src/logic/verdict/assurance.js',
  'packages/verify/src/io/verdict/freshness.js',
  'packages/verify/src/logic/verdict/reviews.js',
  'packages/verify/src/io/verdict/trunk.js',
  'packages/verify/src/io/verdict/withdrawal.js',
  'packages/verify/src/io/review/tier.js',
  // Exact sensitive merge bodies retain their original Strict classification (#1566).
  'packages/merge/src/io/only/verdict.js',
  'packages/merge/src/io/train.js',
  // Exact moved move bodies retain their existing Strict classification (#1583).
  'packages/moves/src/logic/moves/reserveReview.js', 'packages/moves/src/logic/moves/reserveNextReview.js',
  'packages/moves/src/logic/moves/verify.js', 'packages/moves/src/logic/moves/submit.js',
  'packages/moves/src/io/registry.js',
  // Exact moved flake bodies retain their existing Strict classification (#1587).
  'packages/flakes/src/io/main.js', 'packages/flakes/src/io/native/cli.js',
  'packages/flakes/src/io/native.js', 'packages/flakes/src/io/quarantine.js',
  // Exact moved identities retain their existing Strict classification (#1565).
  'packages/items/src/io/parent.js',
  'packages/items/src/io/patches.js',
  'packages/items/src/io/patch/state.js',
  'packages/items/src/io/patch/compose.js',
  'packages/items/src/logic/paths.js',
  'packages/items/src/io/authors.js',
  'package.json', 'pullboard.json', 'apps/cli/src/io/run/tests.js', 'packages/gate/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js', 'packages/gate/src/io/run-tests-watchdog-source.js',
  // Check admission, selection and the evidence that decides whether a failure blocks.
  'src/quarantine.js', 'src/flakes.js', 'src/ci-flakes.js', 'packages/github/src/io/flakes.js', 'src/native-flakes.js', 'src/native-flake-cli.js',
  'packages/gate/src/io/affected/tests.js', 'src/test-selection.js', 'src/test-result-store.js', 'src/test-file-dispatch.js',
  'src/test-run.js', 'packages/gate/src/io/test/file/pool.js', 'src/test-isolation.js', 'src/test-action-cache.js',
  'src/test-action-transfer.js', 'src/test-placement.js', 'packages/codemap/src/io/module/imports.js',
  'src/submit-admission.js', 'src/check-mask.js', 'src/check-baseline.js', 'src/check-baseline-worker.js',
  'src/known-main-reworks.js', 'src/known-main-failures.js', 'src/main-failure-matches.js',
  // These specific review modules judge authority/results; presentation and queue families stay Standard.
  'src/review-policy.js', 'src/review-tier.js', 'src/review-independence.js', 'src/review-routing.js',
  'src/review-eligibility.js', 'src/required-review-family.js', 'src/item-authors.js',
  'src/verdict-admission.js', 'src/verdict-assurance.js', 'src/verdict-freshness.js', 'src/verdict-reviews.js',
  'src/verdict-trunk.js', 'src/verdict-withdrawal.js', 'src/merge-only-verdict.js',
  'src/moves/reserveReview.js', 'src/moves/reserveNextReview.js', 'src/moves/verify.js', 'src/moves/submit.js',
  'src/commands/submit.js', 'src/commands/verify.js', 'src/commands/gate.js', 'src/commands/flakes.js',
  'apps/cli/src/io/commands/submit.js', 'apps/cli/src/io/commands/verify.js', 'apps/cli/src/io/commands/gate.js',
  'apps/cli/src/io/commands/flakes.js', 'apps/cli/src/logic/runner/loss.js',
  // Kernel replay, explicit authentication boundaries and source-bound receipt/landing checks.
  'packages/state/src/io/machine.js', 'packages/state/src/io/engine.js', 'src/registry-guards.js',
  'src/refused.js', 'src/discovery.js', 'src/js-lex.js', 'src/literal-shell-words.js',
  'src/person.js', 'src/person-presence.js', 'src/person-signing.js', 'src/person-request.js', 'src/person-attested.js',
  'src/seal.js', 'packages/kernel/src/logic/seal.js', 'src/sealed-pages.js', 'src/signature.js', 'packages/spec/src/io/signature.js', 'src/agent-grant.js', 'src/coordinator-hold.js',
  'packages/seats/src/io/hold.js', 'packages/seats/src/logic/review/lineage.js', 'src/seat-review-read.js', 'src/parent-session.js', 'src/item-patches.js', 'src/item-patch-state.js',
  'src/item-patch-compose.js', 'src/item-patch-paths.js', 'src/proof-receipts.js', 'src/pre-push-receipts.js',
  'src/train-mechanical-merge.js', 'src/release-gate.js', 'src/release-gate-receipt.js',
  'src/source-advance.js', 'packages/sandbox/src/io/source/advance.js',
  'packages/sandbox/src/io/source/advance/worker.js', 'src/source-advance-state.js', 'src/source-advance-worker.js',
  'src/land.js', 'packages/runners/index.js', 'packages/gate/src/io/browser/admission.js', 'src/gui-admission.js',
  'src/runner-source-scan.js', 'src/runner-history-pack.js', 'src/runner-remote-tooling.js', 'src/runner-request.js',
  'src/runner-result.js', 'src/runner-dispatch.js', 'src/runner-health.js',
  // The same bodies at their current places (those outside the folder rules above); the old paths stay for replay.
  'packages/state/src/logic/admission.js', 'packages/state/src/logic/engines/known-main-failures-engine.js', 'packages/person/src/io/main.js',
  'packages/person/src/io/presence.js', 'packages/person/src/io/signing.js', 'packages/person/src/logic/request.js',
  'packages/person/src/logic/attested.js', 'packages/pages/src/logic/sealed.js', 'packages/state/src/logic/grant.js',
  'packages/git/src/io/receipts.js', 'packages/pages/src/io/relay/cache.js', 'packages/pages/src/io/relay/client.js',
  'packages/pages/src/logic/relay/layout.js', 'packages/pages/src/logic/relay/storage.js', 'packages/pages/src/logic/relay/writer.js',
  'packages/pages/src/io/relay/presentation.js',
]);
// An old Standard body keeps its tier after moving under a cell the area rule would otherwise raise to Strict (#1574).
const STANDARD_MOVED = new Set(['packages/link/src/io/command.js']);
const GUARD_LIST = JSON.parse(fs.readFile(new URL('../../../data/tests/guard.json', import.meta.url), 'utf8'));
// A moved guard test keeps its class under its old path too, so a replay of older work reads the same tier.
const GUARD_TESTS = new Set([...GUARD_LIST.paths, ...Object.keys(GUARD_LIST.moved)]);

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
