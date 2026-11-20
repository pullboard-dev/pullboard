/** @pullboard-module-loads packages/git/src/io/review-folder.js */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { VERIFY_WORDS } from '../../../../../packages/moves/index.js';
import { privateCheckAdmission } from '../../../../../packages/gate/heavy.js';
import { launchComparisonWorker } from '../../../../../packages/verify/index.js';
import { comparisonRestartPlan } from '../../../../../packages/verify/index.js';
import { sharedToolsTarget } from '../toolsnapshot.js';
import { toolsSnapshot } from '../toolsnapshot.js';
import { runPulledComparison } from '../test/pull.js';
import { queueAccept } from '../test/accept.js';
import { queuesAccept } from '../test/accept.js';
import { generateTestTiersAt } from '../../../../../packages/gate/heavy.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { committedTestOutcomes } from '../../../../../packages/gate/heavy.js';
import { submitGateConfig } from '../../../../../packages/gate/heavy.js';
import { submitGatePlan } from '../../../../../packages/gate/heavy.js';
import { sealedMoveOverlap } from '../../../../../packages/verify/index.js';
import { submittedPolicyCommit } from '../../../../../packages/verify/index.js';
import { reusableSubmitProof } from '../../../../../packages/verify/index.js';
import { toolingFor } from '../../../../../packages/pin/index.js';
import { selectTestTiers } from '../../../../../packages/gate/heavy.js';
import { compareVerification } from '../../../../../packages/verify/index.js';
import { changedHunks } from '../../../../../packages/verify/index.js';
import { composesUnchanged } from '../../../../../packages/verify/index.js';
import { comparisonCommand } from '../../../../../packages/verify/index.js';
import { renderVerificationComparison } from '../../../../../packages/verify/index.js';
import { VERIFICATION_COMPARISON_PREFIX } from '../../../../../packages/verify/index.js';
import { mainRunnerSource } from '../../../../../packages/landing/index.js';
import { reviewMainPolicy } from '../../../../../packages/sandbox/index.js';
import { testTierProofFiles } from '../../../../../packages/gate/heavy.js';
import { testTierCommand } from '../../../../../packages/gate/heavy.js';
import { testTierReport } from '../../../../../packages/gate/heavy.js';
import { reviewCitations } from '../../../../../packages/gate/heavy.js';
import { citedReceiptsNote } from '../../../../../packages/gate/heavy.js';
import { landAfterAcceptance } from './land.js';
import { reviewWait } from '../verify/wait.js';
import { sliceVerdictFacts } from '../submit/slice-paths.js';
import { sliceVerdictProblem } from '../../logic/slice-paths.js';
import { reviewPatchAuthors } from '../../../../../packages/verify/index.js';
import { itemTrunkMove } from '../../../../../packages/verify/index.js';
import { boundProofReceipt } from '../../../../../packages/store/index.js';
import { linkKnownMainReworks } from '../../../../../packages/store/index.js';
import { splitAmbiguousMainReds } from '../../../../../packages/store/index.js';
import { sealQuarantineVerdict } from '../../../../../packages/flakes/index.js';
import { compositionSessionOptions } from '../../../../../packages/verify/index.js';
import { frozenCheckTiming } from '../../../../../packages/items/index.js';
import {
  testOutputSummary,
  retainTestOutput,
  renderTestSummary,
  withTestOutput,
} from '../../../../../packages/gate/heavy.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { trunkRef } from '../../../../../packages/sandbox/index.js';
import { selectAffectedTests } from '../../../../../packages/gate/heavy.js';
import { committedItemAuthors } from '../../../../../packages/verify/index.js';
import { earlierHolderProblem } from '../../../../../packages/verify/index.js';
import { verifyOutsideSandbox } from '../../../../../packages/sandbox/index.js';
import { effectiveItemHead } from '../../../../../packages/verify/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import { completeMoveHandoff } from '../../../../../packages/verify/index.js';
import { itemReviewPolicy } from '../../../../../packages/verify/index.js';
import { reviewPacketReadNote } from '../../../../../packages/verify/index.js';
import { reviewPacketRerun } from '../../../../../packages/verify/index.js';
import { twoTierReviews } from '../../../../../packages/verify/index.js';
import { missingCompanionKeys } from '../../../../../packages/items/index.js';
import { prepareItemPatchReview } from '../../../../../packages/items/index.js';
import { composeSliceReview } from '../verify/slices.js';
import { outsideVerdict } from '../../../../../packages/items/index.js';
/** The pullboard verify command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { loadSpec } from '../../../../../packages/spec/index.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  itemSpecIds,
  specApprovalState,
} from '../../../../../packages/spec/index.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from '../../../../../packages/gate/heavy.js';
import {
  refuseSandboxBlocked,
  timingDigest,
  withGateSlot,
} from '../../../../../packages/gate/heavy.js';
import {
  contains,
  git,
  headCommit,
  invalidateGitFacts,
  isClean,
  resolveCommit,
  tryGit,
  untracked,
} from '../../../../../packages/git/index.js';
import {
  guardOf,
  guardRevertNote,
} from '../../../../../packages/commits/index.js';
import {
  checkImplies,
  checklistEvidenceProblem,
  checklistReceipt,
  parseImplies,
} from '../../../../../packages/state/index.js';
import * as itemSessions from '../../../../../packages/items/index.js';
import { itemAuthors } from '../../../../../packages/items/index.js';
import {
  recordMainComparison,
  verify as flakeVerify,
} from '../../../../../packages/flakes/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayRecovered,
} from '../../../../../packages/link/index.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  gateRunnerAdmission,
  loadMachineSettings,
} from '../../../../../packages/config/index.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  policyAt,
  requireTrunkMerge,
  submissionPaths,
} from '../../../../../packages/sandbox/index.js';
import {
  composeReview,
  composesAtAdmission,
  recordNativeProof,
} from '../../../../../packages/verify/index.js';
import {
  captureVerdictReview,
  verdictProjector,
  verdictTrunk,
} from '../../../../../packages/verify/index.js';
import {
  judgeTrunkMove,
} from '../../../../../packages/verify/index.js';
import {
  nextOnce,
  withBoardRead,
  browserAdmissionReporter,
  cdTo,
  checkMainVerifier,
  context,
  freezer,
  idArg,
  landNext,
  ordered,
  queuedItemLease,
  refuseUnverifiedStack,
  resourceAgent,
  textArg,
  whoAmI,
  withBoard,
} from '../entry.js';
import { recordedRecovery } from '../../../../../packages/state/index.js';
import { retryReviewCommit } from '../../../../../packages/verify/index.js';
import { switchToSubmitted } from '../verify.js';
import { mainRedCheckCases } from './submit.js';
import { itemCheckBaseline } from '../../../../../packages/store/index.js';
import { mainComparisonMode } from '../../../../../packages/config/index.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/index.js';
import { submitComposeAsObject } from '../../../../../packages/config/index.js';
import { composeSubmissionMain } from '../../../../../packages/merge/index.js';
import { rejectKeepsCheck } from '../../../../../packages/config/index.js';
import { gateComponentTier } from '../../../../../packages/config/index.js';

const fs = fileSystemAdapter();
/** Loads the review folder module at the call, so cold paths through this command never pay for it. */
const requireModule = createRequire(import.meta.url);

/** The refusal text when main changed files a review touches: a re-review against current main, never a builder merge [C7,U159]. */
export function trunkMovedOverlapText(paths, hunks = []) {
  const named = hunks.length ? `, at ${hunks.map(({ file, header }) => `${JSON.stringify(file)} ${JSON.stringify(header)}`).join(', ')}` : '';
  return `main changed files this item touches during review: ${paths.map(path => JSON.stringify(path)).join(', ')}${named}; ask another agent to re-review against current main`;
}

/** The refusal text when main moved again during the one review retry [C7,U159]. */
export function trunkMovedAgainText(from, to, reach) {
  return `main moved again from ${from} to ${to} during the one review retry${reach.length ? `, reaching this review through ${reach.join('; ')}` : ''}; ask another agent to re-review against current main`;
}

/** Ambiguous known-main cases of one comparison, kept beside the sealed record rather than inside it. */
const AMBIGUOUS_KNOWN = new WeakMap();

/** Compare the complete red check after releasing its slot; unavailable evidence grants nothing. */
export async function knownMainCheck(root, check, { main, item, items, mainRedItems = items, onWait, onMeasuredReceipt, runnerAdmission }) {
  if (mainComparisonMode() === 'off') return null; // gate.mainComparison off: a red check is red [C7,#5565].
  if (check.state !== 'red' || !check.checked || check.executionSourceUnchanged !== true) return null;
  const viaMainRedRepairs = failures => {
    // The submit rule: a case an open Main red repair's own check fails on this main never fails a re-run (#2610).
    try {
      const mainRed = mainRedCheckCases(root, failures, mainRedItems(), item, main, new Map());
      return mainRed.owned.length && !mainRed.rest.length ? { main, failures: mainRed.owned } : null;
    } catch { return null; } // An unavailable baseline never grants a pass.
  };
  let failures = null;
  try {
    const output = check.outputPath ? fs.readFile(check.outputPath, 'utf8') : check.output;
    const run = { ...check, isGreen: false, output,
      stages: [{ status: check.exitCode, output }] };
    failures = failureSignatures(run, root);
    if (!failures?.length) return null;
    // Private checks report paths under their temporary checkout; use the already
    // validated repository-relative failure identities to select main's files.
    const profile = { tests: failures.map(row => ({ file: row.file, passed: false })) };
    const comparison = await compareMainFailures(root, profile, onWait, output, {
      commit: main, detailed: true, onMeasuredReceipt, runnerAdmission,
      execution: { executor: check.executionRunner ? { kind: 'ssh', host: check.executionRunner } : { kind: 'local' }, environment: check.environment },
    });
    const matched = matchingMainFailures(failures, comparison, main);
    // A case several repairs could own is still red on main, so it never keeps the check red (#2528).
    const split = matched ? splitAmbiguousMainReds(matched, items(), item) : null;
    const linked = split ? linkKnownMainReworks(split.clear, items(), item) : null;
    if (linked && split.ambiguous.length) AMBIGUOUS_KNOWN.set(linked, split.ambiguous); // Kept off the sealed record, shown in the note only.
    if (linked) return linked;
  } catch { /* An unavailable comparison falls back to the open Main red repairs below. */ }
  return failures?.length ? viaMainRedRepairs(failures) : null; // Preserve CHECK_RED when ownership cannot be established.
}

/** Retain exact case identities and repair links in the immutable verdict without calling the raw check green. */
export function knownMainCheckNote(known) {
  return known ? `\nfrozen check remains red; identical on main ${known.main}:\n`
    + [...known.failures.map(row => `${row.file} :: ${row.name}; open Main red repair #${row.item}`),
      ...(AMBIGUOUS_KNOWN.get(known) ?? []).map(row => `${row.file} :: ${row.name}; several candidate repairs ${row.candidates.map(id => `#${id}`).join(', ')}`)].join('\n') : '';
}

/** Preserve policy refusals while representing unusable cited criteria as a changed digest. */
export function verificationCriterionDigest(freeze, item) {
  try { return freeze(item).digest; }
  catch (error) {
    if (!(error instanceof Refused)
      || ['A5_GRAMMAR_VERSION', 'MAIN_FACTS_BUSY', 'NO_POLICY', 'NO_CONFIG', 'BAD_CONFIG'].includes(error.code)) throw error;
    return 'missing';
  }
}

/**
 * Render a failed private check's diagnostics: its report when no structured test counts are available, sanitized tail and full-output path.
 *
 * A parsed test summary replaces the duplicate report; plain shell checks and installs keep that report because
 * they have no structured test counts or failures [V18,V2].
 * @param {any} check
 * @param {{ hasStructuredCounts?: boolean }} [options]
 * @returns {string}
 */
function privateCheckEvidence(check, { hasStructuredCounts = false } = {}) {
  const digest = check.report && !hasStructuredCounts ? `; output digest:\n${check.report.replace(/^/gm, '  ')}` : '';
  const tail = check.checked
    ? `\nlast output lines (up to 40):\n${(check.outputTail ?? '(no output)').split('\n').map(line => `  ${line}`).join('\n')}\nfull output file: ${check.outputPath ?? `(unavailable${check.outputError ? `: ${check.outputError}` : ''})`}`
    : '';
  const timings = check.profilePath ? `\n${timingDigest(check.profile)}\ntiming profile: ${check.profilePath}` : '';
  return `${digest}${tail}${timings}`;
}

/**
 * Whether a recovered verdict's note is the retried command's note.
 * The sent note carries machine suffixes (check receipts, main moves, approvals), each starting on a new line,
 * so a retry with the person's original note must match the recorded note with those suffixes.
 * @param {string | undefined} recorded
 * @param {string} given
 * @returns {boolean}
 */
function sameVerdictNote(recorded, given) {
  return typeof recorded === 'string' && (recorded === given || recorded.startsWith(given + '\n'));
}

/**
 * Verify from this checkout (V3, V7): the submitted commit must be here, at or under HEAD, and the
 * criterion is re-read from the spec, so a verdict is never given against a moved bar.
 *
 * @param {any} ctx
 * @param {number} id
 * @param {any} args
 * @returns {Promise<number>}
 */
export async function verifyHere(ctx, id, { second, values }) {
  const decision = { accept: 'ACCEPT', reject: 'REJECT' }[String(second ?? '').toLowerCase()];
  if (!decision) throw new Refused('USAGE', VERIFY_WORDS.usage);
  const runnerAdmission = decision === 'ACCEPT' ? gateRunnerAdmission() : {};
  const implies = parseImplies(values.implies);
  let { root } = ctx.info;
  let verificationProfile = null;
  let verificationOutput = null;
  let verificationQuarantine = null;
  let checklistNote = null;
  let accepted = null;
  let acceptedLandingCommit = null;
  let landedVerdict = false;
  let approvalRows = [];
  /** Record one verdict on the open board. */
  const decide = async (board) => {
    checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const recovered = relayRecovered(root, {}, ctx.io);
    const previous = recovered?.args[1];
    if (recovered?.operation === 'verify' && recovered.args[0] === id && previous?.agentId === me.id &&
        previous.decision === decision && previous.reason === values.reason &&
        sameVerdictNote(previous.note, textArg(ctx.io, values, 'note') ?? '') && previous.cause === (decision === 'REJECT' ? values.cause : undefined) &&
        previous.clause === (decision === 'REJECT' ? values.clause : undefined)) {
      if (decision === 'ACCEPT' && !recordedRecovery(board, recovered)) {
        const item = store.getItem(board, id);
        const commit = resolveCommit(root, item.item_commit);
        if (!commit) throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: ${cdTo(root)} git switch --detach ${item.item_commit.slice(0, 12)}`);
        const trunk = requireTrunkMerge(root, commit);
        refuseUnverifiedStack(root, board, item, commit, trunk);
      }
      return await ordered(ctx, board, 'verify', recovered.args);
    }
    const item = store.getItem(board, id);
    const earlier = earlierHolderProblem(board, item, me.id);
    if (earlier) throw earlier;
    itemSessions.refuseSelfSession(ctx.info, item, agentSessionDigest(), itemAuthors(board, item, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard', ...compositionSessionOptions(board, item), independence: board.reviewIndependence });
    // The builder is always refused on its own forced landing, whatever the commit authors say: the claim history names it [V1,H16].
    if (item.item_status === 'withdrawn' && item.item_merged_commit &&
        (item.item_built_by === me.id || store.events(board, { itemId: id }).some(event => event.event_kind === 'claim' && event.event_by === me.id))) {
      throw new Refused('SELF_VERIFY', VERIFY_WORDS.selfVerify);
    }
    // A forced-landed item takes one verdict: a second one, by any seat, is refused before the move [V1,H16].
    if (item.item_status === 'withdrawn' && item.item_merged_commit && item.item_verdict) {
      throw new Refused('NOT_LANDED', `item #${id} already has a ${item.item_verdict} verdict by ${item.item_verified_by ?? 'another seat'}; a forced-landed item takes one verdict`);
    }
    // A forced merge landed this item around the gate; a verdict is recorded on the board and the landing stays (V1).
    if (item.item_status === 'withdrawn' && item.item_merged_commit) {
      landedVerdict = true;
      return await ordered(ctx, board, 'verify', [id, { agentId: me.id, decision, reason: values.reason, note: textArg(ctx.io, values, 'note') ?? '',
        head: item.item_merged_commit, digest: item.item_frozen_digest ?? '', policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, landed: true,
        // The setting is read here, where the reject is issued; the move trusts only this recorded argument [#9637].
        ...(decision === 'REJECT' && rejectKeepsCheck() ? { keepCheck: true } : {}) }]);
    }
    const reReview = item.item_status === 'verified' && !item.item_merged_commit;
    const stale = reReview ? verdictProjector(root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled() }).state(item) : null;
    if (item.item_status !== 'submitted' && !stale) {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted`);
    }
    // With slices.composeLanding on, a slice is accepted only through its parent and a parent only once its slices are in [C7].
    const composedProblem = sliceVerdictProblem({ decision, ...sliceVerdictFacts(board, item.item_id), composeLanding: ctx.config.slices?.composeLanding });
    if (composedProblem) {
      throw new Refused(composedProblem, composedProblem === 'SLICE_REVIEWED_WITH_PARENT'
        ? `item #${id} is a slice: its parent's ACCEPT covers it; reject it alone, or accept the parent`
        : `item #${id} has slices that are not submitted yet; accept it once they are`);
    }
    if (item.outside) return outsideVerdict(ctx, board, item, me, decision, values, { checkNeedsBrowser, freezer, ordered, resourceAgent, textArg, withGateSlot, verifyOutsideSandbox, itemPolicy, requireTrunkMerge, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
    // Refuse a bad --read before composition, gate admission or any test run: it is pure input, and a full proof that
    // ends in USAGE wastes minutes and leaves nothing recorded (#3085).
    const readNote = reviewPacketReadNote(ctx.info.commonDir, item, values.read, decision);
    // Name an unknown implied item before the frozen check runs, not after it.
    if (implies) checkImplies(board, implies);
    const policy = itemPolicy(root, item);
    ctx = { ...ctx, config: policy.config };
    // An item with no test check is verified only against its review checklist: the board refuses a line that names
    // no file, link or quoted passage before any accept, and the reviewer judges only what the lines show (#996).
    const thread = decision === 'ACCEPT' ? store.itemThread(board, id) : [];
    if (decision === 'ACCEPT') { const problem = checklistEvidenceProblem(item, thread); if (problem) throw problem; }
    checklistNote = decision === 'ACCEPT' ? checklistReceipt(item, thread) : null;
    const fromPacket = packetAcceptance(ctx, board, item, decision, reReview, values.read);
    const commit = resolveCommit(root, item.item_commit);
    if (!commit) throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: ${cdTo(root)} git switch --detach ${item.item_commit.slice(0, 12)}`);
    // verify.reviewFolder (off by default): a seat checkout not at the submitted commit is left alone, and the checks run in the detached review folder instead [C7,#8931].
    if (!fromPacket && ctx.config.verify?.reviewFolder === true && !contains(root, commit, headCommit(root) ?? '')) {
      root = requireModule('../../../../../packages/git/src/io/review-folder.js').reviewFolder(root, commit, join(ctx.info.commonDir, 'pullboard-review-folders')).folder;
    }
    // A clean review worktree elsewhere is moved onto the submitted commit, detached, rather than refused (#2907).
    if (!fromPacket && !contains(root, commit, headCommit(root) ?? '')) { switchToSubmitted(ctx.info, commit, item.item_commit.slice(0, 12)); invalidateGitFacts(); }
    const head = fromPacket ? item.item_commit : headCommit(root) ?? '';
    let digest = 'missing';
    let check;
    let review;
    let unaffectedMove = '', cited = [];
    let knownMain = null;
    const companionDigest = store.itemPatchDigest(board, id);
    const missing = missingCompanionKeys(root, board, item, head,
      { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem });
    if (missing.keys.length) throw new Refused('NOT_AT_COMMIT',
      `the review tree lacks companions ${missing.keys.join(', ')} for patch-set ${missing.digest}; run pullboard next --verify ${id} to check out the composed source`);
    digest = verificationCriterionDigest(freezer(ctx, { board }), item);
    if (fromPacket) {
      if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', VERIFY_WORDS.criteriaMoved);
      refuseUnverifiedStack(root, board, item, commit, requireTrunkMerge(root, commit));
      check = { state: 'pass', checked: true, reused: true, executionNote: `\n${fromPacket}` };
      ctx.io.say(fromPacket);
    } else if (decision === 'ACCEPT') {
      if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', VERIFY_WORDS.criteriaMoved);
      // verify.queueAccept (off by default): the frozen check becomes a runner job and the accept returns; its receipt settles the verdict [C7,V4,#3161].
      if (!reReview && !companionDigest && !item.item_effective_head && queuesAccept(reviewMainPolicy(root).config, frozenCheck(item))) {
        return await queueAccept(ctx, board, { item: id, me, commit, main: reviewMainPolicy(root).commit, check: frozenCheck(item), digest });
      }
      // Patch inputs must be composed before browser/GUI classification reads their exact source.
      // slices.composeLanding (off by default): a parent with slice children is reviewed as the parent composed with its slices [C7,#2397].
      const sliceReview = ctx.config.slices?.composeLanding === true && !reReview ? composeSliceReview(root, board, item) : null;
      let checkedCommit = companionDigest || item.item_effective_head ? prepareItemPatchReview(root, board, item, { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem }).commit : sliceReview?.slices.length ? sliceReview.commit : reReview ? head : commit;
      let checkedLabel = reReview ? 'reviewed composition' : 'submitted commit';
      const composeNow = () => {
        const current = requireTrunkMerge(root, checkedCommit);
        if (!contains(root, current.commit, checkedCommit) && !reReview) {
          const builder = item.item_built_by ?? store.events(board, { itemId: item.item_id }).findLast(event => event.event_kind === 'submit')?.event_by;
          if (!builder) throw new Refused('BAD_VERDICT_REVIEW', 'the submitted builder cannot be determined from native history; restore its submission before review');
          checkedCommit = retryReviewCommit(root, checkedCommit, current);
          checkedLabel = 'main-composed review';
          unaffectedMove += `\nAutomatic main merge ${checkedCommit} attributes submitted source ${item.item_commit} to builder ${builder}; checked against main ${current.commit}.`;
          ctx.io.say(`Composed current main ${current.commit.slice(0, 12)} for the review; checking ${checkedCommit.slice(0, 12)}.`);
        }
        // With submit.composeAsObject on, a stale re-review is offered on a fresh object composition of current main and this head [C7,U159].
        const composed = composeReview(root, board, item, checkedCommit, { reReview, head, stale, refuseUnverifiedStack, requireTrunkMerge: () => current, events: store.events,
          composeAsObject: submitComposeAsObject(), composeMain: composeSubmissionMain });
        if (composed.commit !== checkedCommit) {
          checkedCommit = composed.commit;
          checkedLabel = 'main-composed review';
          ctx.io.say(`Composed current main ${current.commit.slice(0, 12)} with the reviewed head for the re-review; checking ${checkedCommit.slice(0, 12)}.`);
        }
        return composed;
      };
      let admitted = companionDigest === null && !item.item_effective_head && composesAtAdmission(ctx.config) && Boolean(frozenCheck(item));
      let trunk = null;
      let proofRetries = 0;
      const reselection = new Error('review composition changed at admission');
      if (!admitted) ({ trunk, review } = composeNow());
      for (let attempt = 0; attempt < 3; attempt += 1) {
        knownMain = null;
        if (!trunk) ({ trunk, review } = composeNow());
        const checkedItem = { ...item, item_commit: checkedCommit };
        const testTiers = selectTestTiers(root, { base: item.item_claim_head, trunk: trunk?.commit, commit: checkedCommit, runner: ctx.config.affectedTests, componentTier: gateComponentTier() });
        const supplement = testTiers ? testTierCommand(testTiers, testTierProofFiles(testTiers, frozenCheck(item))) : '';
        /** Keep the frozen command and selected units inside one immutable private check. */
        const tierCheck = testTiers ? (root, item, options) => checkAtCommit(root, item, { ...options, supplement, testTiers }) : checkAtCommit;
        if (testTiers) { ctx.io.say(testTierReport(testTiers)); cited = reviewCitations(root, testTiers); } // A4: cite seals, never re-check them
        let expectedPlan = null;
        if (head === checkedCommit && isClean(root) && !untracked(root).length && !companionDigest && !item.item_effective_head) {
          try {
            const config = submitGateConfig(ctx.config, policyAt(root, trunk.commit).config);
            const plan = submitGatePlan(root, config, { base: item.item_claim_head, trunk: trunk.commit, commit: checkedCommit, check: frozenCheck(item) });
            expectedPlan = { check: plan.check, files: plan.proofFiles, full: plan.selection.full, deferred: plan.deferred, proofCommand: plan.proofCommand, tiered: Boolean(plan.testTiers) };
          } catch { /* A plan that cannot be reproduced cannot grant reuse. */ }
        }
        let reused = reusableSubmitProof(store.events(board, { itemId: id }), { item, commit: checkedCommit,
          tree: item.item_tree, main: trunk.commit, tooling: toolingTree(root, checkedCommit), check: expectedPlan?.check ?? frozenCheck(item), affectedTests: ctx.config.affectedTests ?? '',
          gate: ctx.config.gate ?? '', supplement, expectedPlan: expectedPlan ?? undefined });
        // A deferred full suite or a main that moved since submit missed the exact-match reuse; the sealed receipts still
        // stand when no moved file reaches the item or its check, so judge that move instead of rerunning [C7].
        const sealedMain = reused.ids || !frozenCheck(item) || reReview || companionDigest || item.item_effective_head ? null : submittedPolicyCommit(store.events(board, { itemId: id }));
        if (sealedMain) {
          let moveNote = '';
          try {
            const overlap = sealedMoveOverlap(root, { from: sealedMain, to: trunk.commit, commit, check: frozenCheck(item) });
            if (overlap) moveNote = `main moved since submit and reaches ${overlap}`;
          } catch (error) { moveNote = `main move since submit cannot be judged (${error.message.split('\n')[0]})`; }
          const sealed = moveNote ? null : reusableSubmitProof(store.events(board, { itemId: id }), { item, commit, tree: item.item_tree, main: sealedMain, tooling: toolingTree(root, commit),
            check: frozenCheck(item), affectedTests: ctx.config.affectedTests ?? '', gate: ctx.config.gate ?? '', supplement: '', allowDeferred: true });
          if (sealed?.ids) reused = sealed;
          else reused = { reason: `${reused.reason}; ${moveNote || sealed.reason}` };
        }
        if (reused.ids && !guardOf(item) && (frozenCheck(item) || supplement)) { // a named guard is re-run: a submit proof never reverted it
          ctx.io.say(`reused submit proof ${reused.ids.join(', ')}`);
          check = { state: 'pass', checked: true, reused: true, environment: reused.environment ?? null, executionNote: `\nreused submit proof ${reused.ids.join(', ')}` };
        } else if (frozenCheck(item) || supplement) {
          ctx.io.say(`submit proof not reused: ${reused.reason}`);
          const { browser, gui, shortEligible } = await privateCheckAdmission(root, [frozenCheck(item), supplement], {
            commit: checkedCommit, allowBrowserFreeChecks: browserFreeChecksEnabled(),
            onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson) });
          try {
            const waitedOn = `the review check${supplement ? ' and its affected tests' : ''} at ${checkedCommit.slice(0, 12)} on a runner`;
            check = await reviewWait(ctx.io, { item: id, what: waitedOn }, signal => withGateSlot(root, async (lease) => {
              if (admitted) {
                const selected = checkedCommit;
                ({ trunk, review } = composeNow());
                admitted = false;
                // The affected tests and browser/GUI admission were selected for the old object.
                // Release this slot and classify the actual composition before running anything.
                if (checkedCommit !== selected) throw reselection;
              }
              const ran = await flakeVerify(ctx, checkedItem, frozenCheck(item) || supplement, { board, main: trunk.commit, commit: checkedCommit }, { ordered, withBoard, resourceAgent, checkAtCommit: tierCheck })(lease);
              return ran.state === 'pass' ? { ...ran, guardNote: await guardRevertNote(root, checkedItem, lease, { checkAtCommit }) } : ran;
            }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, gui, remote: gateRunnersFirstEnabled(), ...runnerAdmission, agent: me.id, item: String(id), kind: 'review', timing: frozenCheckTiming(item), itemCheck: true, shortEligible, onWait: queuedItemLease(ctx, item, me.id, 'review'), signal }));
          } catch (error) {
            if (error === reselection) continue;
            throw error;
          }
        } else {
          ctx.io.say(`submit proof not reused: ${reused.reason}`);
          check = checkAtCommit(root, checkedItem);
        }
        invalidateGitFacts(); // A private check can outlive changes in the reviewer's live checkout.
        refuseSandboxBlocked(check);
        verificationProfile = check.profile ?? null;
        verificationQuarantine = check.blockingVerdict ? { rawExitCode: check.exitCode, proofReceiptId: check.proofReceiptId,
          coveredCases: check.blockingVerdict.quarantines.length, eventIds: check.blockingVerdict.quarantines.slice(0, 8).map(row => row.eventId),
          omittedEvents: Math.max(0, check.blockingVerdict.quarantines.length - 8) } : null;
        if (check.checked && !check.reused) verificationOutput = check.outputPath
          ? testOutputSummary(check.outputPath, { root: check.executionRoot ?? root, profile: check.profile })
          : retainTestOutput(root, check.output ?? check.report ?? '', { root: check.executionRoot ?? root, profile: check.profile });
        const hasStructuredCounts = check.state === 'red'
          && verificationOutput?.counts.passed != null && verificationOutput?.counts.failed != null;
        const evidence = privateCheckEvidence(check, { hasStructuredCounts }) + (verificationOutput ? `\n${renderTestSummary(verificationOutput)}` : '');
        if (check.state === 'unverified') throw withTestOutput(new Refused('CHECK_UNVERIFIED', `the frozen ${check.stage} could not be verified at the ${checkedLabel}; restore the install or check environment, then retry verification${evidence}`), verificationOutput);
        if (check.state === 'red') {
          knownMain = await reviewWait(ctx.io, { item: id, what: `main ${trunk.commit.slice(0, 12)} comparison of the failing cases on a runner` }, () => knownMainCheck(root, check, { main: trunk.commit, item: id,
            items: () => store.listItems(board, { all: true }), runnerAdmission,
            mainRedItems: () => store.listItems(board, { all: true })
              .map(row => { const baseline = itemCheckBaseline(board, row); return baseline ? { ...row, item_check_baseline: baseline } : row; }),
            onWait: queuedItemLease(ctx, item, me.id, 'review'),
            onMeasuredReceipt: receiptId => recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent }),
          }));
          if (!knownMain && check.proofReceiptId) {
            await recordNativeProof(ctx, checkedItem, check, { ordered, withBoard, resourceAgent, proofRunReceipt: store.proofRunReceipt,
              exitFailures: true }, board);
            const gap = store.selectorGapCandidate(board, { agentId: me.id, itemId: id, receiptId: check.proofReceiptId, review });
            if (gap) {
              const recorded = await ordered(ctx, board, 'recordSelectorGap', [{ agentId: me.id, itemId: id, receiptId: check.proofReceiptId, review }]);
              return { decision: 'SELECTOR_GAP', repairItem: recorded.item, filed: recorded.filed };
            }
          }
          if (!knownMain) throw withTestOutput(new Refused('CHECK_RED', `the frozen item check is red at the ${checkedLabel} (${check.stage}); check.install may be needed for dependencies; reject with the failing behavior or ask the builder to fix and resubmit${evidence}`), verificationOutput);
        }
        const receipt = store.events(board, { itemId: id }).filter(event => event.event_kind === 'submit').map(event => JSON.parse(event.event_detail)).find(event => event.commit === commit);
        submissionPaths(root, item, commit, { mainCommit: receipt?.policyCommit, dependencies: dependencySnapshots(board.db, item) });
        const currentTrunk = requireTrunkMerge(root, checkedCommit); // Re-read after the frozen check, before accepting.
        if (headCommit(root) !== head || (reReview && (!isClean(root) || untracked(root).length))) {
          throw new Refused('NOT_AT_COMMIT', 'the reviewed checkout moved during its check; restore the clean reviewed HEAD and retry verification');
        }
        const moved = currentTrunk.commit === trunk.commit ? null
          : itemTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, paths: review.paths });
        // A touched file refuses only when the reviewed patch no longer composes the same: main editing another part
        // of that file leaves the reviewed diff intact, and the lander lands it on the same test. Why: on 5 Nov a
        // finished review of #3089 was thrown away over five fixture files main had moved, then offered again [V4,C7].
        const composes = moved?.overlap.length ? composesUnchanged(root, { base: trunk.commit, checked: checkedCommit, tip: currentTrunk.commit, paths: review.paths }, { hunkKeyed: hunkFreshnessEnabled() }) : null;
        if (moved?.overlap.length && !composes) throw new Refused('VERDICT_TRUNK_MOVED', trunkMovedOverlapText(moved.overlap, changedHunks(root, { base: trunk.commit, checked: checkedCommit, tip: currentTrunk.commit, paths: moved.overlap })));
        if (moved && !knownMain) {
          unaffectedMove += `\nmain moved during this review through ${moved.moved.map(sha => sha.slice(0, 12)).join(', ')}; the reviewed commit still merges and ${composes ? `its patch on ${moved.overlap.map(path => JSON.stringify(path)).join(', ')} composes unchanged` : 'its files are unchanged'}`;
          refuseUnverifiedStack(root, board, item, checkedCommit, currentTrunk);
          break;
        }
        const judged = check.reused || currentTrunk.commit === trunk.commit || ctx.config.verify.unrelatedTrunkMoves !== true ? null
          : await judgeTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, item, checkedCommit, check: frozenCheck(item) }, { selectAffectedTests, explicitCheckFiles });
        if (currentTrunk.commit !== trunk.commit && (knownMain || !judged || judged.overlap)) {
          if (proofRetries++ >= 1) {
            const reach = judged ? (await judgeTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, item, checkedCommit, check: frozenCheck(item) }, { selectAffectedTests, explicitCheckFiles }, { all: true })).overlaps : [];
            throw new Refused('VERDICT_TRUNK_MOVED', trunkMovedAgainText(trunk.commit, currentTrunk.commit, reach));
          }
          checkedCommit = retryReviewCommit(root, checkedCommit, currentTrunk);
          checkedLabel = `retry composition ${checkedCommit}`;
          trunk = currentTrunk;
          review = captureVerdictReview(root, board, item, trunk.commit, checkedCommit, { events: store.events });
          refuseUnverifiedStack(root, board, item, checkedCommit, trunk);
          unaffectedMove += `\nmain moved during review; reran the frozen check once at clean composition ${checkedCommit} against main ${trunk.commit}`;
          continue;
        }
        if (judged) unaffectedMove += `\nmain moved during this review through ${judged.moved.map((sha) => sha.slice(0, 12)).join(', ')}, judged unaffected: none of them changes this item's files or a file its check and affected tests read`;
        refuseUnverifiedStack(root, board, item, checkedCommit, currentTrunk);
        break;
      }
    }
    review ??= captureVerdictReview(root, board, item, verdictTrunk(root, { trunkRef }), undefined, { events: store.events });
    if (decision === 'ACCEPT') approvalRows = itemAgentApprovals(item, specApprovalState(root, { board, config: ctx.config, ids: itemSpecIds(item) }, { store, verifiedPasskeyRowDecision }));
    const approvalNote = agentApprovalLine(approvalRows);
    if (decision === 'ACCEPT') git(root, ['update-ref', `refs/pullboard/items/${id}/${review.head.slice(0, 12)}`, review.head]);
    if (decision === 'ACCEPT' && check?.blockingVerdict) {
      sealQuarantineVerdict(board, boundProofReceipt(board, { receiptId: check.proofReceiptId }));
    }
    return await ordered(ctx, board, 'verify', [id, {
      agentId: me.id,
      decision,
      reason: values.reason,
      note: (textArg(ctx.io, values, 'note') ?? '') + readNote + unaffectedMove + knownMainCheckNote(knownMain) + (check?.guardNote ?? '') + (check?.executionNote ?? '') + (checklistNote ? `\n${checklistNote}` : '') + citedReceiptsNote(cited) + (check?.blockingVerdict ? `\ncomputed quarantine verdict; raw exit ${check.exitCode}; events ${check.blockingVerdict.quarantines.slice(0, 8).map(row => row.eventId).join(', ')}` : '') + (approvalNote ? `\n${approvalNote}` : ''),
      ...(decision === 'REJECT' && values.cause !== undefined ? { cause: values.cause } : {}),
      ...(decision === 'REJECT' && values.clause !== undefined ? { clause: values.clause } : {}),
      head,
      digest,
      policy: ctx.config.verify.policy,
      familyPolicy: ctx.config.verify.family,
      sourceAdvanceHead: item.item_effective_head ?? null,
      review,
      ...(companionDigest ? { companionDigest } : {}),
      environment: check?.environment ?? null,
      ...(decision === 'ACCEPT' ? { check: check.checked ? 'green' : 'none' } : {}),
      ...(knownMain ? { knownMainFailures: knownMain } : {}),
      ...(decision === 'ACCEPT' && check.blockingVerdict ? { quarantineProofId: check.proofReceiptId } : {}),
      ...(implies ? { implies } : {}),
    }]);
  };
  const result = await withBoard(ctx, async (board) => {
    const verdict = await decide(board);
    if (verdict.decision === 'ACCEPT' && !landedVerdict) {
      accepted = store.getItem(board, id);
      acceptedLandingCommit = store.checkedLandingCommit(board, accepted);
    }
    return verdict;
  });
  if (result.decision === 'QUEUED') {
    ctx.io.result?.({ id, ...result });
    ctx.io.say(`#${id} accept queued: the frozen check is runner job ${result.checkJob}; the review is reserved to ${result.reservedTo}, and the verdict records when the check finishes.`);
    return 0;
  }
  const primary = { id, ...result, ...(checklistNote ? { reviewEvidence: checklistNote } : {}), ...(verificationQuarantine ? { quarantine: verificationQuarantine } : {}), ...(verificationOutput ?? {}), ...(approvalRows.length ? { agentApproved: approvalRows, approvalQualification: agentApprovalLine(approvalRows) } : {}) };
  ctx.io.result?.(primary);
  if (result.decision === 'SELECTOR_GAP') {
    ctx.io.say(`Recorded a selector gap for #${id}; repair item #${result.repairItem} is open. #${id} remains submitted for review.`);
    if (ctx.verdictResult) ctx.verdictResult.value = primary;
    return 0;
  }
  const verifiedSummary = timingDigest(verificationProfile);
  const verifiedTiming = result.decision === 'ACCEPT' && verificationProfile && verifiedSummary ? `\n${verifiedSummary}\ntiming profile: ${verificationProfile.profilePath ?? '(not saved)'}` : '';
  ctx.io.say(result.decision === 'ACCEPT'
    ? `verified #${id}: ${result.reason}${result.check === 'none' ? '; no frozen check ran' : ''}${result.decision === 'ACCEPT' && checklistNote ? '; review evidence proved it' : ''}${approvalRows.length ? `; ${agentApprovalLine(approvalRows)}` : ''}${verificationQuarantine ? `; computed quarantine verdict; raw exit ${verificationQuarantine.rawExitCode}; ${verificationQuarantine.coveredCases} covered case(s), proof ${verificationQuarantine.proofReceiptId}` : ''}${verificationOutput ? '\n' + renderTestSummary(verificationOutput) : ''}${verifiedTiming}`
    : `rejected #${id}: ${result.reason}${result.clause ? `; clause: ${result.clause}` : ''}; ${result.held ? 'held until its bar is sharpened' : 'it is open again for rework'}`);
  if (accepted) {
    let automatic = true;
    try { automatic = await landAfterAcceptance(ctx); }
    catch (error) { ctx.io.err(`automatic landing retained accepted work: ${error.code ?? error.name}: ${error.message}`); }
    if (!automatic) ctx.io.say(landNext(ctx.info, accepted, acceptedLandingCommit, { spec: loadSpec(ctx.info.root, ctx.config) }));
  }
  if (ctx.verdictResult) ctx.verdictResult.value = primary;
  return 0;
}

/**
 * The verdict line when an accept can be recorded from the stored review packet, or null when it must
 * run the frozen check; a packet with an uncovered clause says which clause forced the check.
 *
 * Why: a packet is stored only after a green gate at the submitted head, so when every clause cites a
 * recorded run there, the accept needs no checkout, test run or main merge of its own. The landing step
 * still composes main and runs the landing gate. Companions, a source advance and a re-review change the
 * reviewed tree, so they always take the full path.
 */
function packetAcceptance(ctx, board, item, decision, reReview, read) {
  // An item with no frozen check still accepts from its packet: the gate's recorded runs are its whole proof, and the
  // full path would only rerun those same tests. Why: on 6 Nov three check-less reviews each reran 50 to 63 s on a
  // runner with every clause already covered. A guarded item keeps the full path so its guard runs [V4,C7].
  if (decision !== 'ACCEPT' || reReview || guardOf(item)
    || item.item_effective_head || store.itemPatchDigest(board, item.item_id)) return null;
  const packet = reviewPacketRerun(ctx.info.commonDir, item);
  if (!packet) return null;
  if (packet.failures) {
    ctx.io.say(`review packet ${packet.head.slice(0, 12)} records failures at head; running the frozen check`);
    return null;
  }
  // An uncovered clause the reviewer lists in --read is read evidence. Rerunning the frozen check here repeats the
  // run the gate already recorded green at this head, so it can never cover a clause the gate did not; it only
  // costs the reviewer 2 to 4 minutes. Why: 82 of the last 150 packets had an uncovered clause on 6 Nov [V4,C7].
  const readClauses = read === undefined ? new Set() : String(read).trim() === 'all' ? new Set(packet.rerun) : new Set(String(read).split(',').map(part => Number(part.trim())));
  const readUncovered = packet.rerun.filter(n => readClauses.has(n));
  const forced = packet.rerun.filter(n => !readClauses.has(n));
  if (forced.length) {
    ctx.io.say(`review packet ${packet.head.slice(0, 12)}: clause ${forced.join(', ')} has no recorded run and was not read; taking the full accept path, which reuses the submit proof when it still covers the head`);
    return null;
  }
  const reading = readUncovered.length ? ` and the reviewer read clause${readUncovered.length > 1 ? 's' : ''} ${readUncovered.join(', ')} that no run covers` : '';
  const named = [...readClauses].filter(Number.isInteger).sort((x, y) => x - y);
  const reviewed = named.length ? `clause${named.length > 1 ? 's' : ''} ${named.join(', ')}` : 'the review packet';
  return `accepted from review packet ${packet.head.slice(0, 12)}: every ${readUncovered.length ? 'other ' : ''}clause is covered by a recorded green run at the submitted head${reading}; accepted on the gate's green receipts and your reading of ${reviewed}`;
}

/** Run `pullboard verify` and return its exit code. */
export async function run(io, args) {
  const { first, values } = args;
  const id = idArg(first);
  const ctx = { ...context(io), verdictResult: {} };
  if (values.compare) {
    if (args.second) throw new Refused('USAGE', 'use pullboard verify <id> --compare without an accept or reject verdict');
    const item = withBoardRead(ctx, board => store.getItem(board, id));
    const policy = reviewMainPolicy(ctx.info.root);
    const executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };
    if (process.env.PULLBOARD_COMPARE_SOURCE && (process.env.PULLBOARD_COMPARE_SOURCE !== item.item_commit
      || process.env.PULLBOARD_COMPARE_DIGEST !== item.item_frozen_digest)) {
      io.result?.({ item: id, status: 'superseded' }); return 0;
    }
    let compared;
    try {
      compared = await compareVerification(ctx.info.root, item, { main: policy.commit, runnerAvailable: () => executionServices.runners.effectiveRunners(loadMachineSettings()).length > 0,
        selectTests: async (root, pair) => {
          const selected = selectAffectedTests(root, pair);
          const tiered = selectTestTiers(root, pair);
          // Tiers come from the commit's Git objects, so no clone or checkout is made on this machine [C7,V4].
          const units = tiered?.units ?? generateTestTiersAt(root, pair.commit).files.filter(row => row.tier === 'T1').map(row => row.file);
          const allowed = new Set(units);
          return { ...selected, files: selected.files.filter(file => allowed.has(file)) };
        },
        // Each side is a pulled test job at its commit id: any runner, the machine's own loopback runner included, claims
        // it, so no checkout or worktree is made here and no SSH controller transport is needed [C7,V4,P7].
        runTests: async (commit, files, { profileFile }) => {
          const root = ctx.info.root;
          const source = mainRunnerSource(root, commit, policy.commit);
          if (!source) return { unavailable: 'the exact comparison commit could not be read from the object store' };
          const command = comparisonCommand(policy.config.affectedTests || 'node --test', files);
          const runId = randomUUID();
          const ran = await runPulledComparison(ctx, { item: id, commit: source.head, main: policy.commit, command, files, runId });
          // Outcomes count only for regular test files at the run's own commit; anything else leaves the side unaccounted.
          const testOutcomes = committedTestOutcomes(root, source.head, ran.outcomes, tryGit);
          const profile = { id: runId, job: ran.job, runner: ran.runner, green: ran.green, ...(testOutcomes ? { testOutcomes } : {}) };
          const profileFd = fs.open(profileFile, 'w', 0o600);
          try { fs.write(profileFd, JSON.stringify(profile) + '\n'); } finally { fs.close(profileFd); }
          return { id: runId, isGreen: ran.green, executionRunner: ran.runner, profile, ...(testOutcomes ? { testOutcomes } : {}) };
        },
      });
      compared = { ...compared, status: 'complete', source: item.item_commit, digest: item.item_frozen_digest };
    } catch (error) {
      compared = { item: id, status: 'unavailable', source: item.item_commit, digest: item.item_frozen_digest,
        error: error.message };
    }
    await recordComparison(ctx, item, compared);
    io.result?.(compared);
    io.say(renderVerificationComparison(compared));
    return compared.status === 'unavailable' ? 1 : 0;
  }
  const code = await verifyHere(ctx, id, args);
  if (code === 0 && ctx.verdictResult.value) await completeMoveHandoff(ctx, id, values, ctx.verdictResult.value, { nextOnce, withBoardRead, listItems: store.listItems, agentSessionDigest, reviewOnly: true });
  return code;
}

/** Store observation facts only while the exact submitted source and frozen bar are still current. */
async function recordComparison(ctx, item, result) {
  return withBoard(ctx, async board => {
    const current = store.getItem(board, item.item_id);
    if (current.item_commit !== item.item_commit || current.item_frozen_digest !== item.item_frozen_digest) return;
    await ordered(ctx, board, 'appendFact', [item.item_id, { agentId: whoAmI(ctx, board).id, kind: 'measurement',
      text: VERIFICATION_COMPARISON_PREFIX + JSON.stringify(result) }]);
  });
}

/** How a comparison gets its tools: a cold shared snapshot is built by the detached worker, so submit returns first (#5752) [C7]. */
const COMPARISON_TOOLS = { snapshot: toolsSnapshot, plan: sharedToolsTarget, snapshotModule: new URL('../toolsnapshot.js', import.meta.url).href };

/** A pending comparison whose worker died starts again from its recorded request, and is recorded unavailable after three restarts [C7]. */
export async function reviveStalledComparison(ctx, id) {
  const item = withBoardRead(ctx, board => store.getItem(board, id));
  const thread = withBoardRead(ctx, board => store.itemThread(board, id));
  const plan = comparisonRestartPlan({ commonDir: ctx.info.commonDir, item, thread });
  if (plan.action === 'unavailable') {
    await recordComparison(ctx, item, { item: id, status: 'unavailable', source: item.item_commit, digest: item.item_frozen_digest, error: plan.error });
  } else if (plan.action === 'restart') {
    await launchComparisonWorker({ origin: ctx.info.root, commonDir: ctx.info.commonDir,
      toolRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), entry: 'apps/cli/pullboard.js',
      item: id, source: item.item_commit, digest: item.item_frozen_digest }, COMPARISON_TOOLS);
  }
}

/**
 * Detach a pulled green submission's comparison worker for the board API, which recorded it pending; a launch that
 * fails is recorded unavailable on the board, so no review waits on a comparison that never ran (#7267) [C7,V4].
 *
 * @param {{ root: string, item: number, source: string, digest: string }} request - root: the board's repository.
 * @returns {Promise<void>}
 */
export async function launchPulledComparison({ root, item, source, digest }) {
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  try {
    await launchComparisonWorker({ origin: root, commonDir, toolRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), entry: 'apps/cli/pullboard.js',
      item, source, digest }, COMPARISON_TOOLS);
  } catch (error) {
    const { openBoard, closeBoard } = await import('../../../../lib/index.js');
    const board = openBoard(store.boardFilePath(commonDir));
    try {
      const current = store.getItem(board, item);
      if (current?.item_commit === source && current.item_frozen_digest === digest) {
        store.appendFact(board, item, { agentId: current.item_owner ?? 'coordinator', kind: 'measurement',
          text: VERIFICATION_COMPARISON_PREFIX + JSON.stringify({ item, status: 'unavailable', source, digest, error: String(error?.message ?? error).slice(0, 500) }) });
      }
    } finally { closeBoard(board); }
  }
}

/**
 * The tooling tree a review judges under (RFC 0007 SC8), or null when the pin is unreadable, so nothing is reused.
 *
 * @param {string} root - The reviewer's checkout.
 * @param {string} commit - The reviewed commit.
 * @returns {string | null} The tooling tree id.
 */
function toolingTree(root, commit) {
  try { return toolingFor(root, commit).tooling; } catch { return null; }
}
