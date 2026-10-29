import { frozenCheckTiming } from '../check-timing.js';
import {
  testOutputSummary,
  retainTestOutput,
  renderTestSummary,
  withTestOutput,
} from '../test-output-summary.js';
import { checkAtCommit } from '../runner-private-check.js';
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';
import { trunkRef } from '../trusted-policy-read.js';
import { selectAffectedTests } from '../affected-tests.js';
import { committedItemAuthors } from '../review-independence.js';
import { verifyOutsideSandbox } from '../sandbox-verify.js';
import { effectiveItemHead } from '../source-advance-state.js';
import { agentSessionDigest } from '../person.js';
import { verifiedPasskeyRowDecision } from '../person-row-proof.js';
import { completeMoveHandoff } from '../post-move-handoff.js';
import { itemReviewPolicy } from '../review-independence.js';
import { twoTierReviews } from '../review-independence.js';
import { prepareItemPatchReview } from '../item-patch-review.js';
import { outsideVerdict } from '../outside-verify.js';
/** The pullboard verify command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import { loadSpec } from '../spec.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  specApprovalState,
} from '../spec-approval.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from '../browser-admission.js';
import {
  refuseSandboxBlocked,
  timingDigest,
  withGateSlot,
} from '../gate.js';
import {
  contains,
  git,
  headCommit,
  invalidateGitFacts,
  isClean,
  resolveCommit,
  untracked,
} from '../git.js';
import {
  guardRevertNote,
} from '../guard-revert.js';
import {
  checkImplies,
  parseImplies,
} from '../implies.js';
import { checkNeedsGui } from '../gui-admission.js';
import * as itemSessions from '../item-sessions.js';
import { itemAuthors } from '../item-authors.js';
import * as nativeFlakes from '../native-flake-cli.js';
import {
  Refused,
} from '../refused.js';
import {
  relayRecovered,
} from '../relay.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  gateRunnerAdmission,
} from '../settings.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  requireTrunkMerge,
  submissionPaths,
} from '../trusted-policy.js';
import {
  composeReview,
  composesAtAdmission,
} from '../verdict-admission.js';
import {
  captureVerdictReview,
  verdictProjector,
  verdictTrunk,
} from '../verdict-freshness.js';
import {
  judgeTrunkMove,
} from '../verdict-trunk.js';
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
import { recordedRecovery } from '../recorded-recovery.js';
import { retryReviewCommit } from '../verdict-retry.js';

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
  let accepted = null;
  let acceptedLandingCommit = null;
  let approvalRows = [];
  /** Record one verdict on the open board. */
  const decide = async (board) => {
    checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const recovered = relayRecovered(root);
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
    itemSessions.refuseSelfSession(ctx.info, item, agentSessionDigest(), itemAuthors(board, item, { committedItemAuthors, twoTierReviews }), { commitOnly: twoTierReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'standard' });
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
    const companionDigest = store.itemPatchDigest(board, id);
    try {
      digest = freezer(ctx, { board })(item).digest;
    } catch (error) {
      if (!(error instanceof Refused) || error.code === 'A5_GRAMMAR_VERSION') throw error;
    }
    if (decision === 'ACCEPT') {
      if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', 'the criterion changed; ask the coordinator to refreeze this item before checking it');
      // Patch inputs must be composed before browser/GUI classification reads their exact source.
      let checkedCommit = companionDigest || item.item_effective_head ? prepareItemPatchReview(root, board, item, { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem: store.getItem }).commit : reReview ? head : commit;
      let checkedLabel = reReview ? 'reviewed composition' : 'submitted commit';
      const composeNow = () => composeReview(root, board, item, checkedCommit, { reReview, head, stale, refuseUnverifiedStack, requireTrunkMerge, events: store.events });
      const admitted = companionDigest === null && !item.item_effective_head && composesAtAdmission(ctx.config) && Boolean(frozenCheck(item));
      let trunk = null;
      if (!admitted) ({ trunk, review } = composeNow());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const checkedItem = { ...item, item_commit: checkedCommit };
        if (frozenCheck(item)) {
          const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(root, frozenCheck(item), { commit: checkedCommit, onFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson) });
          const gui = await checkNeedsGui(root, frozenCheck(item), { commit: checkedCommit });
          // Exact command classifiers still govern local and remote private-check admission [C7,V4].
          const shortEligible = Boolean(await explicitCheckFiles(root, frozenCheck(item), { commit: checkedCommit }));
          check = await withGateSlot(root, async (lease) => { if (admitted && attempt === 0) ({ trunk, review } = composeNow()); const ran = await nativeFlakes.verify(ctx, checkedItem, frozenCheck(item), { board, main: trunk.commit, commit: checkedCommit }, { ordered, withBoard, resourceAgent, checkAtCommit })(lease); return ran.state === 'pass' ? { ...ran, guardNote: guardRevertNote(root, checkedItem, lease, { checkAtCommit }) } : ran; }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, gui, remote: gateRunnersFirstEnabled(), ...runnerAdmission, agent: me.id, item: String(id), kind: 'review', timing: frozenCheckTiming(item), itemCheck: true, shortEligible, onWait: queuedItemLease(ctx, item, me.id, 'review') });
        } else {
          check = checkAtCommit(root, checkedItem);
        }
        invalidateGitFacts(); // A private check can outlive changes in the reviewer's live checkout.
        refuseSandboxBlocked(check);
        verificationProfile = check.profile ?? null;
        if (check.checked) verificationOutput = check.outputPath
          ? testOutputSummary(check.outputPath, { root: check.executionRoot ?? root, profile: check.profile })
          : retainTestOutput(root, check.output ?? check.report ?? '', { root: check.executionRoot ?? root, profile: check.profile });
        const evidence = verificationOutput ? `\n${renderTestSummary(verificationOutput)}` : '';
        if (check.state === 'unverified') throw withTestOutput(new Refused('CHECK_UNVERIFIED', `the frozen ${check.stage} could not be verified at the ${checkedLabel}; restore the install or check environment, then retry verification${evidence}`), verificationOutput);
        if (check.state === 'red') throw withTestOutput(new Refused('CHECK_RED', `the frozen item check is red at the ${checkedLabel} (${check.stage}); check.install may be needed for dependencies; reject with the failing behavior or ask the builder to fix and resubmit${evidence}`), verificationOutput);
        const receipt = store.events(board, { itemId: id }).filter(event => event.event_kind === 'submit').map(event => JSON.parse(event.event_detail)).find(event => event.commit === commit);
        submissionPaths(root, item, commit, { mainCommit: receipt?.policyCommit, dependencies: dependencySnapshots(board.db, item) });
        const currentTrunk = requireTrunkMerge(root, checkedCommit); // Re-read after the frozen check, before accepting.
        // With verify.unrelatedTrunkMoves on, a move through commits that touch nothing this review read keeps its verdict (#928).
        const judged = currentTrunk.commit === trunk.commit || ctx.config.verify.unrelatedTrunkMoves !== true ? null
          : await judgeTrunkMove(root, { from: trunk.commit, to: currentTrunk.commit, item, checkedCommit, check: frozenCheck(item) }, { selectAffectedTests, explicitCheckFiles });
        if (headCommit(root) !== head || (reReview && (!isClean(root) || untracked(root).length))) {
          throw new Refused('NOT_AT_COMMIT', 'the reviewed checkout moved during its check; restore the clean reviewed HEAD and retry verification');
        }
        if (currentTrunk.commit !== trunk.commit && (!judged || judged.overlap)) {
          if (attempt === 1) throw new Refused('VERDICT_TRUNK_MOVED', `main moved again from ${trunk.commit} to ${currentTrunk.commit} during the one review retry; merge the latest main and re-review the clean composition`);
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
    return await ordered(ctx, board, 'verify', [id, {
      agentId: me.id,
      decision,
      reason: values.reason,
      note: (textArg(ctx.io, values, 'note') ?? '') + unaffectedMove + (check?.guardNote ?? '') + (check?.executionNote ?? '') + (approvalNote ? `\n${approvalNote}` : ''),
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
  const primary = { id, ...result, ...(verificationOutput ?? {}), ...(approvalRows.length ? { agentApproved: approvalRows, approvalQualification: agentApprovalLine(approvalRows) } : {}) };
  ctx.io.result?.(primary);
  const verifiedSummary = timingDigest(verificationProfile);
  const verifiedTiming = result.decision === 'ACCEPT' && verificationProfile && verifiedSummary ? `\n${verifiedSummary}\ntiming profile: ${verificationProfile.profilePath ?? '(not saved)'}` : '';
  ctx.io.say(result.decision === 'ACCEPT'
    ? `verified #${id}: ${result.reason}${result.check === 'none' ? '; no frozen check ran' : ''}${approvalRows.length ? `; ${agentApprovalLine(approvalRows)}` : ''}${verificationOutput ? '\n' + renderTestSummary(verificationOutput) : ''}${verifiedTiming}`
    : `rejected #${id}: ${result.reason}${result.clause ? `; clause: ${result.clause}` : ''}; ${result.held ? 'held until its bar is sharpened' : 'it is open again for rework'}`);
  if (accepted) ctx.io.say(landNext(ctx.info, accepted, acceptedLandingCommit, { spec: loadSpec(ctx.info.root, ctx.config) }));
  if (ctx.verdictResult) ctx.verdictResult.value = primary;
  return 0;
}

/** Run `pullboard verify` and return its exit code. */
export async function run(io, args) {
  const { first, values } = args;
  const id = idArg(first);
  const verdictResult = {};
  const ctx = { ...context(io), verdictResult };
  const code = await verifyHere(ctx, id, args);
  if (code === 0 && verdictResult.value) await completeMoveHandoff(ctx, id, values, verdictResult.value, { nextOnce, withBoardRead, listItems: store.listItems });
  return code;
}
