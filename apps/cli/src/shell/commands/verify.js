import { privateCheckAdmission } from '../../../../../packages/gate/index.js';
import { launchComparisonWorker } from '../../../../../packages/verify/index.js';
import { generateTestTiers } from '../../../../../packages/gate/index.js';
import { fileURLToPath } from 'node:url';
import { submitGateConfig } from '../../../../../packages/gate/index.js';
import { submitGatePlan } from '../../../../../packages/gate/index.js';
import { reusableSubmitProof } from '../../../../../src/submit-proof-reuse.js';
import { selectTestTiers } from '../../../../../packages/gate/index.js';
import { compareVerification } from '../../../../../packages/verify/index.js';
import { comparisonCommand } from '../../../../../packages/verify/index.js';
import { renderVerificationComparison } from '../../../../../packages/verify/index.js';
import { recordedVerificationComparison } from '../../../../../packages/verify/index.js';
import { VERIFICATION_COMPARISON_PREFIX } from '../../../../../packages/verify/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { runProfiledShellAsync } from '../../../../../packages/gate/index.js';
import { testsNeedBrowser } from '../../../../../packages/gate/index.js';
import { testsNeedGui } from '../../../../../packages/gate/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { testTierProofFiles } from '../../../../../packages/gate/index.js';
import { testTierCommand } from '../../../../../packages/gate/index.js';
import { testTierReport } from '../../../../../packages/gate/index.js';
import { landAfterAcceptance } from './land.js';
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
} from '../../../../../packages/gate/index.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { trunkRef } from '../../../../../packages/sandbox/index.js';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { committedItemAuthors } from '../../../../../packages/verify/index.js';
import { verifyOutsideSandbox } from '../../../../../packages/sandbox/index.js';
import { effectiveItemHead } from '../../../../../packages/verify/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import { completeMoveHandoff } from '../../../../../packages/verify/index.js';
import { itemReviewPolicy } from '../../../../../packages/verify/index.js';
import { reviewPacketReadNote } from '../../../../../packages/verify/index.js';
import { twoTierReviews } from '../../../../../packages/verify/index.js';
import { missingCompanionKeys } from '../../../../../packages/items/index.js';
import { prepareItemPatchReview } from '../../../../../packages/items/index.js';
import { outsideVerdict } from '../../../../../packages/items/index.js';
/** The pullboard verify command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { loadSpec } from '../../../../../packages/spec/index.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  specApprovalState,
} from '../../../../../packages/spec/index.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from '../../../../../packages/gate/index.js';
import {
  refuseSandboxBlocked,
  timingDigest,
  withGateSlot,
} from '../../../../../packages/gate/index.js';
import {
  contains,
  git,
  headCommit,
  invalidateGitFacts,
  isClean,
  resolveCommit,
  untracked,
} from '../../../../../packages/git/index.js';
import {
  guardRevertNote,
} from '../../../../../packages/commits/index.js';
import {
  checkImplies,
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
} from '../cli.js';
import { recordedRecovery } from '../../../../../packages/state/index.js';
import { retryReviewCommit } from '../../../../../packages/verify/index.js';
import { readFileSync } from 'node:fs';
import { mainRedCheckCases } from './submit.js';
import { itemCheckBaseline } from '../../../../../packages/store/index.js';

/** Ambiguous known-main cases of one comparison, kept beside the sealed record rather than inside it. */
const AMBIGUOUS_KNOWN = new WeakMap();

/** Compare the complete red check after releasing its slot; unavailable evidence grants nothing. */
export async function knownMainCheck(root, check, { main, item, items, mainRedItems = items, onWait, onMeasuredReceipt, runnerAdmission }) {
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
    const output = check.outputPath ? readFileSync(check.outputPath, 'utf8') : check.output;
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
 * Render a failed private check's own diagnostics: its output digest, sanitized tail and private full-output path.
 *
 * The test-output summary reads test counts and failing cases, which a plain shell check or install has none of,
 * so a refusal must still carry the digest, tail and path the check recorded [V18,V2].
 */
function privateCheckEvidence(check) {
  const digest = check.report ? `; output digest:\n${check.report.replace(/^/gm, '  ')}` : '';
  const tail = check.checked
    ? `\nlast output lines (up to 40):\n${(check.outputTail ?? '(no output)').split('\n').map(line => `  ${line}`).join('\n')}\nfull output file: ${check.outputPath ?? `(unavailable${check.outputError ? `: ${check.outputError}` : ''})`}`
    : '';
  const timings = check.profilePath ? `\n${timingDigest(check.profile)}\ntiming profile: ${check.profilePath}` : '';
  return `${digest}${tail}${timings}`;
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
  if (!decision) throw new Refused('USAGE', 'pullboard verify <id> accept, or reject --reason CODE --note "..."');
  const runnerAdmission = decision === 'ACCEPT' ? gateRunnerAdmission() : {};
  const implies = parseImplies(values.implies);
  const { root } = ctx.info;
  let verificationProfile = null;
  let verificationOutput = null;
  let verificationQuarantine = null;
  let accepted = null;
  let acceptedLandingCommit = null;
  let approvalRows = [];
  /** Record one verdict on the open board. */
  const decide = async (board) => {
    checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const recovered = relayRecovered(root, {}, ctx.io);
    const previous = recovered?.args[1];
    if (recovered?.operation === 'verify' && recovered.args[0] === id && previous?.agentId === me.id &&
        previous.decision === decision && previous.reason === values.reason &&
        previous.note === (textArg(ctx.io, values, 'note') ?? '') && previous.cause === (decision === 'REJECT' ? values.cause : undefined) &&
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
    itemSessions.refuseSelfSession(ctx.info, item, agentSessionDigest(), itemAuthors(board, item, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard', ...compositionSessionOptions(board, item) });
    const reReview = item.item_status === 'verified' && !item.item_merged_commit;
    const stale = reReview ? verdictProjector(root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef }).state(item) : null;
    if (item.item_status !== 'submitted' && !stale) {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted`);
    }
    if (item.outside) return outsideVerdict(ctx, board, item, me, decision, values, { checkNeedsBrowser, freezer, ordered, resourceAgent, textArg, withGateSlot, verifyOutsideSandbox, itemPolicy, requireTrunkMerge, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
    // Name an unknown implied item before the frozen check runs, not after it.
    if (implies) checkImplies(board, implies);
    const policy = itemPolicy(root, item);
    ctx = { ...ctx, config: policy.config };
    const head = headCommit(root) ?? '';
    const commit = resolveCommit(root, item.item_commit);
    if (!commit || !contains(root, commit, head)) {
      throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: ${cdTo(root)} git switch --detach ${item.item_commit.slice(0, 12)}`);
    }
    let digest = 'missing';
    let check;
    let review;
    let unaffectedMove = '';
    let knownMain = null;
    const companionDigest = store.itemPatchDigest(board, id);
    const missing = missingCompanionKeys(root, board, item, head,
      { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem });
    if (missing.keys.length) throw new Refused('NOT_AT_COMMIT',
      `the review tree lacks companions ${missing.keys.join(', ')} for patch-set ${missing.digest}; run pullboard next --verify ${id} to check out the composed source`);
    digest = verificationCriterionDigest(freezer(ctx, { board }), item);
    if (decision === 'ACCEPT') {
      if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', 'the criterion changed; ask the coordinator to refreeze this item before checking it');
      // Patch inputs must be composed before browser/GUI classification reads their exact source.
      let checkedCommit = companionDigest || item.item_effective_head ? prepareItemPatchReview(root, board, item, { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem }).commit : reReview ? head : commit;
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
        return composeReview(root, board, item, checkedCommit, { reReview, head, stale, refuseUnverifiedStack, requireTrunkMerge: () => current, events: store.events });
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
        const testTiers = selectTestTiers(root, { base: item.item_claim_head, trunk: trunk?.commit, commit: checkedCommit, runner: ctx.config.affectedTests });
        const supplement = testTiers ? testTierCommand(testTiers, testTierProofFiles(testTiers, frozenCheck(item))) : '';
        /** Keep the frozen command and selected units inside one immutable private check. */
        const tierCheck = testTiers ? (root, item, options) => checkAtCommit(root, item, { ...options, supplement, testTiers }) : checkAtCommit;
        if (testTiers) ctx.io.say(testTierReport(testTiers));
        let expectedPlan = null;
        if (head === checkedCommit && isClean(root) && !untracked(root).length && !companionDigest && !item.item_effective_head) {
          try {
            const config = submitGateConfig(ctx.config, policyAt(root, trunk.commit).config);
            const plan = submitGatePlan(root, config, { base: item.item_claim_head, trunk: trunk.commit, commit: checkedCommit, check: frozenCheck(item) });
            expectedPlan = { check: plan.check, files: plan.proofFiles, full: plan.selection.full, deferred: plan.deferred, proofCommand: plan.proofCommand };
          } catch { /* A plan that cannot be reproduced cannot grant reuse. */ }
        }
        const reused = expectedPlan ? reusableSubmitProof(store.events(board, { itemId: id }), { item, commit: checkedCommit,
          tree: item.item_tree, main: trunk.commit, check: expectedPlan.check, affectedTests: ctx.config.affectedTests ?? '',
          gate: ctx.config.gate ?? '', supplement, expectedPlan }) : { reason: 'clean submit plan unavailable' };
        if (reused.ids && (frozenCheck(item) || supplement)) {
          ctx.io.say(`reused submit proof ${reused.ids.join(', ')}`);
          check = { state: 'pass', checked: true, reused: true, executionNote: `\nreused submit proof ${reused.ids.join(', ')}` };
        } else if (frozenCheck(item) || supplement) {
          ctx.io.say(`submit proof not reused: ${reused.reason}`);
          const { browser, gui, shortEligible } = await privateCheckAdmission(root, [frozenCheck(item), supplement], {
            commit: checkedCommit, allowBrowserFreeChecks: browserFreeChecksEnabled(),
            onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson) });
          try {
            check = await withGateSlot(root, async (lease) => {
              if (admitted) {
                const selected = checkedCommit;
                ({ trunk, review } = composeNow());
                admitted = false;
                // The affected tests and browser/GUI admission were selected for the old object.
                // Release this slot and classify the actual composition before running anything.
                if (checkedCommit !== selected) throw reselection;
              }
              const ran = await flakeVerify(ctx, checkedItem, frozenCheck(item) || supplement, { board, main: trunk.commit, commit: checkedCommit }, { ordered, withBoard, resourceAgent, checkAtCommit: tierCheck })(lease);
              return ran.state === 'pass' ? { ...ran, guardNote: guardRevertNote(root, checkedItem, lease, { checkAtCommit }) } : ran;
            }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, gui, remote: gateRunnersFirstEnabled(), ...runnerAdmission, agent: me.id, item: String(id), kind: 'review', timing: frozenCheckTiming(item), itemCheck: true, shortEligible, onWait: queuedItemLease(ctx, item, me.id, 'review') });
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
        const evidence = privateCheckEvidence(check) + (verificationOutput ? `\n${renderTestSummary(verificationOutput)}` : '');
        if (check.state === 'unverified') throw withTestOutput(new Refused('CHECK_UNVERIFIED', `the frozen ${check.stage} could not be verified at the ${checkedLabel}; restore the install or check environment, then retry verification${evidence}`), verificationOutput);
        if (check.state === 'red') {
          knownMain = await knownMainCheck(root, check, { main: trunk.commit, item: id,
            items: () => store.listItems(board, { all: true }), runnerAdmission,
            mainRedItems: () => store.listItems(board, { all: true })
              .map(row => { const baseline = itemCheckBaseline(board, row); return baseline ? { ...row, item_check_baseline: baseline } : row; }),
            onWait: queuedItemLease(ctx, item, me.id, 'review'),
            onMeasuredReceipt: receiptId => recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent }),
          });
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
        if (moved?.overlap.length) throw new Refused('VERDICT_TRUNK_MOVED',
          `main changed files this item touches during review: ${moved.overlap.map(path => JSON.stringify(path)).join(', ')}; merge current main and re-review`);
        if (moved && !knownMain) {
          unaffectedMove += `\nmain moved during this review through ${moved.moved.map(sha => sha.slice(0, 12)).join(', ')}; the reviewed commit still merges and its files are unchanged`;
          refuseUnverifiedStack(root, board, item, checkedCommit, currentTrunk);
          break;
        }
        const judged = check.reused || currentTrunk.commit === trunk.commit || ctx.config.verify.unrelatedTrunkMoves !== true ? null
          : await judgeTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, item, checkedCommit, check: frozenCheck(item) }, { selectAffectedTests, explicitCheckFiles });
        if (currentTrunk.commit !== trunk.commit && (knownMain || !judged || judged.overlap)) {
          if (proofRetries++ >= 1) {
            const reach = judged ? (await judgeTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, item, checkedCommit, check: frozenCheck(item) }, { selectAffectedTests, explicitCheckFiles }, { all: true })).overlaps : [];
            throw new Refused('VERDICT_TRUNK_MOVED', `main moved again from ${trunk.commit} to ${currentTrunk.commit} during the one review retry${reach.length ? `, reaching this review through ${reach.join('; ')}` : ''}; merge the latest main and re-review the clean composition`);
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
    if (decision === 'ACCEPT') approvalRows = itemAgentApprovals(item, specApprovalState(root, { board, config: ctx.config }, { store, verifiedPasskeyRowDecision }));
    const approvalNote = agentApprovalLine(approvalRows);
    if (decision === 'ACCEPT') git(root, ['update-ref', `refs/pullboard/items/${id}/${review.head.slice(0, 12)}`, review.head]);
    if (decision === 'ACCEPT' && check?.blockingVerdict) {
      sealQuarantineVerdict(board, boundProofReceipt(board, { receiptId: check.proofReceiptId }));
    }
    return await ordered(ctx, board, 'verify', [id, {
      agentId: me.id,
      decision,
      reason: values.reason,
      note: (textArg(ctx.io, values, 'note') ?? '') + reviewPacketReadNote(ctx.info.commonDir, item, values.read, decision) + unaffectedMove + knownMainCheckNote(knownMain) + (check?.guardNote ?? '') + (check?.executionNote ?? '') + (check?.blockingVerdict ? `\ncomputed quarantine verdict; raw exit ${check.exitCode}; events ${check.blockingVerdict.quarantines.slice(0, 8).map(row => row.eventId).join(', ')}` : '') + (approvalNote ? `\n${approvalNote}` : ''),
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
    if (verdict.decision === 'ACCEPT') {
      accepted = store.getItem(board, id);
      acceptedLandingCommit = store.checkedLandingCommit(board, accepted);
    }
    return verdict;
  });
  const primary = { id, ...result, ...(verificationQuarantine ? { quarantine: verificationQuarantine } : {}), ...(verificationOutput ?? {}), ...(approvalRows.length ? { agentApproved: approvalRows, approvalQualification: agentApprovalLine(approvalRows) } : {}) };
  ctx.io.result?.(primary);
  const verifiedSummary = timingDigest(verificationProfile);
  const verifiedTiming = result.decision === 'ACCEPT' && verificationProfile && verifiedSummary ? `\n${verifiedSummary}\ntiming profile: ${verificationProfile.profilePath ?? '(not saved)'}` : '';
  ctx.io.say(result.decision === 'ACCEPT'
    ? `verified #${id}: ${result.reason}${result.check === 'none' ? '; no frozen check ran' : ''}${approvalRows.length ? `; ${agentApprovalLine(approvalRows)}` : ''}${verificationQuarantine ? `; computed quarantine verdict; raw exit ${verificationQuarantine.rawExitCode}; ${verificationQuarantine.coveredCases} covered case(s), proof ${verificationQuarantine.proofReceiptId}` : ''}${verificationOutput ? '\n' + renderTestSummary(verificationOutput) : ''}${verifiedTiming}`
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

/** Run `pullboard verify` and return its exit code. */
export async function run(io, args) {
  const { first, values } = args;
  const id = idArg(first);
  const verdictResult = {};
  const ctx = { ...context(io), verdictResult };
  if (values.compare) {
    if (args.second) throw new Refused('USAGE', 'use pullboard verify <id> --compare without an accept or reject verdict');
    const item = withBoardRead(ctx, board => store.getItem(board, id));
    const policy = mainPolicy(ctx.info.root);
    const executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };
    if (process.env.PULLBOARD_COMPARE_SOURCE && (process.env.PULLBOARD_COMPARE_SOURCE !== item.item_commit
      || process.env.PULLBOARD_COMPARE_DIGEST !== item.item_frozen_digest)) {
      io.result?.({ item: id, status: 'superseded' }); return 0;
    }
    let compared;
    try {
      compared = await compareVerification(ctx.info.root, item, { main: policy.commit,
        selectTests: async (root, pair) => {
          const selected = selectAffectedTests(root, pair);
          const tiered = selectTestTiers(root, pair);
          const units = tiered?.units ?? await withMainCheckout(root, pair.commit, checkout =>
            generateTestTiers(checkout).files.filter(row => row.tier === 'T1').map(row => row.file));
          const allowed = new Set(units);
          return { ...selected, files: selected.files.filter(file => allowed.has(file)) };
        },
        runTests: (commit, files, { profileFile, artifactDirectory }) => withMainCheckout(ctx.info.root, commit, async checkout => {
          const command = comparisonCommand(policy.config.affectedTests || 'node --test', files);
          const browser = await testsNeedBrowser(checkout, files);
          return withGateSlot(checkout, lease => {
            lease.testTiers = true;
            return runProfiledShellAsync(checkout, command,
              { gateLease: lease, waitMs: lease.waitMs, profileFile, artifactDirectory, persistLog: true, stages: true });
          }, { executionServices, ...gateRunnerAdmission(), runnerOnly: true, remote: true,
            browser, gui: testsNeedGui(checkout, files), shortEligible: true, item: String(id), kind: 'compare' });
        }),
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
  if (code === 0 && verdictResult.value) await completeMoveHandoff(ctx, id, values, verdictResult.value, { nextOnce, withBoardRead, listItems: store.listItems, agentSessionDigest });
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

/** A green submission records pending before detaching work; no comparison grants gate or verdict authority. */
export async function startAutomaticComparison(ctx, id) {
  const item = withBoardRead(ctx, board => store.getItem(board, id));
  const previous = withBoardRead(ctx, board => recordedVerificationComparison(store.itemThread(board, id), item));
  if (previous && ['pending', 'complete'].includes(previous.status)) return;
  const pending = { item: id, status: 'pending', source: item.item_commit, digest: item.item_frozen_digest };
  await recordComparison(ctx, item, pending);
  try {
    await launchComparisonWorker({ origin: ctx.info.root, commonDir: ctx.info.commonDir,
      toolRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), entry: 'bin/pullboard.js',
      item: id, source: item.item_commit, digest: item.item_frozen_digest });
  } catch (error) { await recordComparison(ctx, item, { ...pending, status: 'unavailable', error: error.message }); }
}
