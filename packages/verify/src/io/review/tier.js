import { STRICT_RENAME_ENGINE } from '../../../../state/light.js';
/** Deterministic classification uses native submitted paths, never prose or receiver files [V4,B26,H16]. */
import { REVIEW_DEFAULT_ENGINE } from '../../../../state/light.js';
import { REVIEW_TIER_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { readFileSync } from 'node:fs';
import { itemPatches } from '../../../../items/light.js';
import { itemPatchPaths } from '../../../../items/light.js';
import { outsideSource } from '../../../../items/light.js';

// Rulings 39301/39401: source areas and named guard tests, never all test/board/review/person families.
const SOURCE_DIRECTORIES = ['apps/relay/', 'packages/gate/src/', 'packages/auth/src/', 'packages/kernel/src/', 'packages/landing/src/', 'packages/runners/src/', 'apps/runner/src/',
  '.githooks/', '.husky/', '.github/workflows/'];
const SOURCE_FILES = new Set([
  // Preserve the strict tier of the exact moved relay workers (#1591).
  'apps/lib/src/io/worker/checkpoint/relay.js',
  'apps/cli/src/io/sender.js',
  // The old flat relay-* page files, now in the pages cell, keep the family rule's Strict tier.
  'packages/pages/src/io/relay/cache.js', 'packages/pages/src/io/relay/client.js', 'packages/pages/src/logic/relay/layout.js',
  'packages/pages/src/logic/relay/storage.js', 'packages/pages/src/logic/relay/writer.js', 'packages/pages/src/io/relay/presentation.js',
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
  'package.json', 'pullboard.json', 'packages/gate/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js', 'packages/gate/src/io/run-tests-watchdog-source.js',
  // Check admission, selection and the evidence that decides whether a failure blocks.
  'packages/github/src/io/flakes.js',
  'packages/gate/src/io/affected/tests.js', 'packages/gate/src/io/test/selection.js', 'packages/gate/src/io/test/store.js', 'packages/gate/src/io/test/file/dispatch.js',
  'packages/gate/src/io/test/run.js', 'packages/gate/src/io/test/file/pool.js', 'packages/gate/src/io/test/isolation.js', 'packages/gate/src/io/test/action/cache.js',
  'packages/gate/src/io/test/action/transfer.js', 'packages/gate/src/io/test/placement.js', 'packages/codemap/src/io/module/imports.js',
  'packages/state/src/logic/admission.js', 'packages/gate/src/io/check/baseline.js', 'packages/gate/src/io/check/baseline/worker.js',
  'packages/state/src/logic/engines/known-main-failures-engine.js', 'packages/landing/src/io/main/matches.js',
  // These specific review modules judge authority/results; presentation and queue families stay Standard.
  'apps/cli/src/io/commands/submit.js', 'apps/cli/src/io/commands/verify.js', 'apps/cli/src/io/commands/gate.js',
  'apps/cli/src/io/commands/flakes.js', 'apps/cli/src/logic/runner/loss.js',
  // Kernel replay, explicit authentication boundaries and source-bound receipt/landing checks.
  'packages/state/src/io/machine.js', 'packages/state/src/io/engine.js', 'packages/kernel/src/logic/registry.js',
  'packages/kernel/src/logic/refused.js', 'packages/kernel/src/logic/discovery.js', 'packages/kernel/src/logic/lex.js', 'packages/kernel/src/logic/words.js',
  'packages/person/src/io/main.js', 'packages/person/src/io/presence.js', 'packages/person/src/io/signing.js', 'packages/person/src/logic/request.js', 'packages/person/src/logic/attested.js',
  'packages/kernel/src/logic/seal.js', 'packages/pages/src/logic/sealed.js', 'packages/spec/src/io/signature.js', 'packages/state/src/logic/grant.js',
  'packages/seats/src/io/hold.js', 'packages/seats/src/logic/review/lineage.js',
  'packages/git/src/io/receipts.js',
  'packages/gate/src/io/release.js', 'packages/gate/src/io/release/receipt.js',
  'packages/sandbox/src/io/source/advance.js',
  'packages/sandbox/src/io/source/advance/worker.js',
  'packages/landing/src/io/land.js', 'packages/runners/index.js', 'packages/gate/src/io/browser/admission.js', 'packages/gate/src/io/gui/admission.js',
  'packages/runners/src/io/source/scan.js', 'packages/runners/src/io/pack.js', 'packages/runners/src/io/tooling/remote.js', 'packages/runners/src/io/request.js',
  'packages/runners/src/io/result.js', 'packages/runners/src/io/dispatch.js', 'packages/runners/src/io/health.js',
]);
// An old Standard body keeps its tier after moving under a cell the area rule would otherwise raise to Strict (#1574).
const STANDARD_MOVED = new Set(['packages/link/src/io/command.js']);
const GUARD_LIST = JSON.parse(readFileSync(new URL('../../../data/tests/guard.json', import.meta.url), 'utf8'));
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
