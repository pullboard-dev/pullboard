import { reviewPatchAuthors } from "../../../verify/index.js";
import { frozenFamilyPolicy } from './relaxation.js';
export { recordExitProgress, requireExitActive } from "../logic/exit/rules/claim.js";
/**
 * The board (B1–B7, V1–V8, R1–R3): items, claims, submissions, verdicts and shouts in one SQLite
 * file in the git common dir, so every worktree sees the same board and nothing is committed.
 *
 * Every move is one immediate transaction (B2), so two agents can never claim the same item, and
 * every move lands in an append-only event log (R2). The caller supplies what only git and the
 * spec know: the commit, the verifier's checkout, the frozen criterion.
 *
 * This file keeps the shared plumbing every move writes through (moveItem, setItem, the reviewer
 * and coordinator checks); each move or command lives in its own src/board-<move>.js module and is
 * re-exported here, so a change to one move no longer edits the file every other move shares [C7].
 */
import { committedItemAuthors } from "../../../verify/index.js";
import { strictReviewProblem } from "../../../verify/index.js";
import { reviewReleaseCooldown as routingReviewReleaseCooldown } from "../../../verify/index.js";
import { seatFamily } from "../../../verify/index.js";
import { routingStrictReviewProblem } from "../../../verify/index.js";
import { reviewFamilyProblem } from "../../../verify/index.js";
import { twoTierReviews } from "../../../verify/index.js";
import { setItem as writeItemFields } from "../../../items/index.js";
import { foreignBlockers as readForeignBlockers } from "../../../items/index.js";
import { foreignDependencyStates as readForeignDependencyStates } from "../../../items/index.js";
import { readReceivedBoardState } from "../logic/board/link.js";
import { requiredReviewFamilyProblem } from "../../../verify/index.js";
import { laneLeads } from "../../../seats/index.js";
import { PERSON } from "./board/query.js";
import { now } from "./board/query.js";
import { current } from "./board/query.js";
import { reviewReleasesSinceSubmit } from "./board/query.js";
import { itemById } from "./board/query.js";
import { reviewHolder } from "./board/query.js";
import { events } from "./board/query.js";
import { proofReceipts } from "./receipts.js";
import { prepareMergeOnlySubmit } from "../../../merge/index.js";
import { atomic } from "./board/event/log.js";
import { logEvent } from "./board/event/log.js";
import { verdictReviewProblem } from "../../../verify/index.js";
import { verdictsFor } from "../../../verify/index.js";
import { acceptedVerdict } from "../../../verify/index.js";
import { checkedLandingCommit } from "../../../verify/index.js";
import { itemFiles } from "../../../items/index.js";
import { companionWindowProblem } from "../../../items/index.js";
import { COORDINATOR } from "../../../config/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { GUARDS } from "../../../state/index.js";
import { IN_STATE } from "../../../state/index.js";
import { MOVES } from "../../../state/index.js";
import { STATES } from "../../../state/index.js";
import { UNKNOWN_MOVE } from "../../../state/index.js";
import { effectiveGuards } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";
import { submitHandoff } from "./submit/handoff/records.js";
import { itemAuthorProblem } from "../../../items/index.js";
import { ROUTES } from "../../../seats/index.js";
import { canTake } from "../../../seats/index.js";
import { routeOf } from "../../../seats/index.js";
import { RIGOR_NOTICE_ENGINE } from "../logic/board/rigor/provenance.js";
import { RIGOR_AUTO_ENGINE } from "../../../state/light.js";
import { factReference } from "../../../spec/index.js";
import { landingFlakes } from "../logic/board/landing/exceptions.js";
import { landingWaiverCovers } from "../logic/board/landing/exceptions.js";
import { landingWaiverKind } from "../logic/board/landing/exceptions.js";
import { landingBatches } from "../../../git/index.js";
import { recordRelayRefusal } from "./board/refusal.js";
import { linkPublishRepair } from "./board/repair.js";
import { register } from "./board/register.js";
export { REMOTE_AGENT_PATH, isRemoteAgentPath } from "./board/register.js";
import { ensureCoordinator } from "./board/coordinator.js";
import { addItem } from "./board/add.js";
import { validateItemAddition } from "./board/add.js";
import { planCompanion } from "./board/companion.js";
import { requestCompanion } from "./board/companion.js";
import { editItem } from "./board/edit.js";
import { validateItemEdit } from "./board/edit.js";
import { attachItemPatch } from "./board/patch/attach.js";
import { objectItemPatch } from "./board/patch/attach.js";
import { removeItemPatch } from "./board/patch/remove.js";
import { prepareClaim as preparedClaim } from "./board/claim.js";
import { claim as applyPreparedClaim } from "./board/claim.js";
import { release } from "./board/release.js";
import { submit } from "./board/submit.js";
import { prepareSubmit } from "./board/submit.js";
import { sealClauseInspection } from "./board/submit.js";
import { sealStrictRenames } from "./board/submit.js";
import { reviewReleaseNoteProblem } from "./board/review/note.js";
import { reviewOffer } from "./board/review/offer.js";
import { reserveReview } from "./board/reserve/review.js";
import { reserveNextReview } from "./board/reserve/next.js";
import { verify } from "./board/verify.js";
import { verdictEvidence } from "./board/verify.js";
import { reopen } from "./board/reopen.js";
import { merged } from "./board/merged.js";
import { withdraw } from "./board/withdraw.js";
import { refreeze } from "./board/refreeze.js";
import { shout } from "./board/shout.js";
import { recordHealthFindings } from "./board/record/findings.js";
import { passDecision } from "./board/decision/pass.js";
import { answerDecision } from "./board/decision/answer.js";
import { appendFact } from "./board/fact.js";
import { buildOrder } from "./board/order.js";
import { nextFor } from "./board/next.js";
import { gateAtHead } from "./board/next.js";
import { holdLane } from "./board/hold/lane.js";
import { releaseLane } from "./board/release/lane.js";
import { holdItem } from "./board/hold/item.js";
import { releaseItemHold } from "./board/release/hold.js";
import { maintainStaleState } from "./board/stale.js";
import { recordRowDecisions } from "./board/record/decisions.js";
import { applyRowDecisions } from "./board/apply/decisions.js";
import { recordLandingBatch } from "./board/record/landing/batch.js";
import { recordLandingWaiver } from "./board/record/landing/waiver.js";
import { recordLandingFlake } from "./board/record/landing/flake.js";
import { finishLandingBatch } from "./board/batch.js";
import { intakeOutside } from "./board/outside/intake.js";
import { applyRehomeItem } from "./board/apply/rehome.js";
import { approveOutside } from "./board/outside/approve.js";
import { setLaneLead } from "./board/lane/lead.js";
import { activityDeliveryState } from "./board/delivery.js";
import { activityInterruptWasDelivered } from "./board/delivery.js";
import { recordActivityDelivery } from "./board/delivery.js";
import { actOnActivity } from "./board/activity.js";
import { openHandoff } from "./board/handoff/open.js";
import { takeHandoff } from "./board/handoff/take.js";
import { recordNextIdle } from "./board/record/idle.js";
import { persistShout } from "./board/shout.js";
import { rigorAutoDraftOn } from "./board/shout.js";
export { laneLeads };

export { itemPatches, itemPatchDigest, followItemPatches } from "../../../items/index.js";
export { readBoardMembers, setBoardMembers } from "./board/members.js";
export {
  getShout,
  allShouts,
  shoutDetails,
  decisionAnswers,
  openRequests,
  pendingRefreeze,
  pendingRefreezeProblem,
  milestonePriorities,
  peekShouts,
  projectItemThreads,
  milestones,
  unverifiedSubmissions,
} from "./board/read/shouts.js";
export { lineSettings } from "../../../state/light.js";
export { setLineSetting } from "./board/settings.js";

export {
  itemRedirect,
  rehomeDestinationItemId,
  rehomeImport,
  rehomeItem,
  reserveRehomeItemId,
} from "./board/facade.js";
export { setBarReady, signBar, seatFamily, canonicalFamily } from "../../../verify/index.js";
export { coordinatorCheck, completeCheckBaseline, itemCheckAuthor } from "./baseline/check.js";

export { atomic, logEvent };
export { verdictReviewProblem, verdictsFor, acceptedVerdict, checkedLandingCommit };
export { landingTestDefects, recordLandingTestDefect, closeLandingTestDefect } from "../logic/board/landing/test/defects.js";
export { recordSelectorGap, selectorGapCandidate } from "../logic/board/gap.js";
export { relandAccepted, acceptedRelandCandidate, relandConflictRecorded } from "../logic/board/reland.js";
export { landingLeaseMove, landingLeaseState } from "../logic/board/landing/lease.js";
export { boardBusyError } from "./board/access.js";
export { schemaMissing, writeRefused } from "./board/migrate.js";
export { itemFiles };
export { ROUTES, canTake };
export { landingFlakes, landingWaiverCovers, landingWaiverKind };
export { acceptCheck } from "../../../verify/index.js";
export { declareJob, recordJobRun } from "../logic/board/jobs.js";
export { recordUsage } from "../../../stats/light.js";
export { recordUsageBatch } from "../../../stats/light.js";
export { recordSharedUsage } from "../../../stats/light.js";
export { proofReceipts, recordProofRun, storeTestReceipt } from "./receipts.js";
/** Seat rules live in seats.js and agent readers in board-query.js; the board re-exports them so `store.*` callers keep one import. */
export { agentCreator, coordinatorHolder, nextSeatId, seatEnrolled, seatLineage, withVerifierStanding } from "../../../seats/index.js";
export { agentAt, agentById, listAgents } from "./board/query.js";
export { takeCoordinator } from "./board/hold.js";

export const ACCEPT_REASON = 'CRITERION_MET';
export { PERSON } from "./board/query.js";

export { EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION, BOARD_BUSY_TIMEOUT_MS, SCHEMA_VERSION } from "./board/schema/source.js";

const REVIEW_RELEASE_COOLDOWN_MS = 60 * 60 * 1000;

export const REJECT_REASONS = [
  'TEST_FAILURE',
  'BEHAVIOR_MISMATCH',
  'INSUFFICIENT_EVIDENCE',
  'STALE_HEAD',
  'OTHER',
];

export { systemClock } from "./board/read/snapshot.js";


export { openBoardReadOnly, readBoardSnapshot } from "./board/read/snapshot.js";

export { readEventLogVersion } from "./board/read/snapshot.js";

export { boardId } from "./board/query.js";

export { closeBoard } from "./board/read/snapshot.js";

export { itemById } from "./board/query.js";

/**
 * The refusal codes packages/state/src/io/machine.js declares for a guard of a move: the guard's own and any
 * additional typed refusals, or for the state check, the move's.
 *
 * @param {any} move
 * @param {string} id
 * @returns {string[]}
 */
function declaredCodes(move, id) {
  if (id === IN_STATE) return [move.refuse];
  const guard = GUARDS.find((entry) => entry.id === id);
  return [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)];
}

/** Validate the original declared guards without mutating the item; preparation reuses their exact order. */
function checkedItemMove(board, id, verb, checks, transition = null) {
  const move = transition ?? MOVES.find((entry) => entry.verb === verb);
  if (!move) throw new Refused(UNKNOWN_MOVE.refuse, `${UNKNOWN_MOVE.rule}: ${UNKNOWN_MOVE.next}`);
  let item = null;
  for (const guard of effectiveGuards(move)) {
    if (guard === 'itemExists') {
      item = itemById(board, id);
      continue;
    }
    if (!(guard in checks)) throw new Error(`move ${verb}: guard ${guard} has no check`);
    const check = checks[guard];
    if (check === null) continue;
    if (guard === IN_STATE && move.from.includes(item.item_status)) continue;
    const refusal = check(item);
    if (refusal === null) continue;
    const codes = declaredCodes(move, guard);
    if (!codes.includes(refusal.code)) {
      throw new Error(`move ${verb}: guard ${guard} refused with ${refusal.code}; the declaration says ${codes.join(' or ')}`);
    }
    throw refusal;
  }
  return { move, item };
}

/**
 * Apply one declared move to an item (M1, M2). This is the only code that writes an item's status.
 *
 * It checks the move's guards, then any exit guard of its target the move does not name, in the
 * order packages/state/src/io/machine.js declares them, and refuses with the first that does not hold. `checks` has
 * one entry per guard: a function given the item that returns null when the guard holds or the
 * refusal when it does not, or null for a guard the caller has already checked, such as the CLI's
 * look at git and the gate. The item's state is checked against the move's declared starting
 * states; its entry supplies only the refusal. Each refusal must carry the code the declaration
 * gives that guard, so the code here and the declaration cannot drift apart. Once every guard
 * holds, `before` runs, for what must exist before the write, such as the verdict that proves an
 * accept; then the target state's fields are checked and the status written with `set`.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} verb
 * @param {{ checks: Record<string, ((item: any) => Refused | null) | null>, set?: (item: any) => object, before?: (item: any) => void, transition?: object }} how
 * @returns {any} The item as it was before the move.
 */
export function moveItem(board, id, verb, { checks, set = () => ({}), before = () => {}, transition = null, unchanged = null }) {
  const { move, item } = checkedItemMove(board, id, verb, checks, transition);
  // A validated no-op retains the exact row, including its lease and update time.
  if (unchanged?.(item)) return item;
  before(item);
  const fields = { ...set(item), item_status: move.to };
  const requires = STATES.find((state) => state.id === move.to).requires;
  const missing = requires.filter((field) => !String({ ...item, ...fields }[field] ?? '').trim());
  if (missing.length) throw new Error(`move ${verb}: ${move.to} needs ${missing.join(', ')}`);
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try {
    setItem(board, id, fields);
  } finally {
    board.db.exec('DELETE FROM temp.moving');
  }
  return item;
}

/**
 * The refusal when the caller is not the coordinator, or null when it is.
 *
 * @param {string} agentId
 * @param {string} what
 * @returns {Refused | null}
 */
export const onlyCoordinator = (agentId, what) => (agentId === COORDINATOR ? null : new Refused('COORDINATOR_ONLY', `only the coordinator ${what}`));

export { prepareMergeOnlySubmit };

export { reviewHolder } from "./board/query.js";

/** Native composition providers for the store's lower-layer family routing rule. */

/** Return a reviewer's active one-hour cooldown, if a later submission has not reset it [V1,R1]. */
export const reviewReleaseCooldown = (board, itemId, agentId) => routingReviewReleaseCooldown(board, itemId, agentId, { engineVersion: ENGINE_VERSION, reviewReleasesSinceSubmit, cooldownMs: REVIEW_RELEASE_COOLDOWN_MS });

export { reviewQueueBreakdown } from "./board/query.js";

export { reviewQueue } from "./board/query.js";

/**
 * The refusal for reviewing an item whose submitted head has a queued hand-off but no captured submit proof receipt,
 * or null when the receipt exists or no hand-off was ever queued for it.
 *
 * Why: only a terminal green or submitted result with the receipt the production gate writes gives a reviewer proof;
 * queued, running, incomplete (SUBMIT_HANDOFF_RESULT with no receipt, the #3722 case), red and infrastructure
 * states leave nothing to review, and a reject there counts toward the send-back hold (#3737, #3744). Items with no
 * hand-off at all (older boards, synthetic submits) stay reviewable.
 *
 * @param {any} board
 * @param {any} item
 * @returns {Refused | null}
 */
export function gateReceiptProblem(board, item) {
  if (item.item_status !== 'submitted' || !item.item_commit) return null;
  const job = submitHandoff(board, item.item_id);
  if (!job || (job.commit !== item.item_commit && job.submitted !== item.item_commit)) return null;
  const captured = ['green', 'submitted'].includes(job.state) && proofReceipts(board, item.item_id).some(receipt => receipt.kind === 'submit'
    && receipt.commit === job.executionCommit && receipt.tree === job.executionTree && receipt.seat === job.agentId
    && receipt.frozenDigest === job.digest && receipt.sourceClean === true);
  return captured ? null
    : new Refused('GATE_PENDING', `the gate for #${item.item_id} has no captured proof receipt at ${String(item.item_commit).slice(0, 12)} (hand-off ${job.state}), so there is nothing to review; it becomes reviewable when its gate result and receipt exist: pullboard next --verify`);
}

/**
 * What a verifier must pass before it reviews an item, alike when it reserves the review and when
 * it gives its verdict: it did not build the item, its route covers the item's, the repo's verify
 * policy lets it, and no other agent holds the review (V15). A reservation that lapsed holds
 * nothing, so the agent that made it can still give its verdict unless another reserved it since.
 *
 * @param {any} board
 * @param {{ agentId: string, policy: string, familyPolicy?: string }} who
 * @returns {Record<string, (found: any) => Refused | null>}
 */
export function reviewerChecks(board, { agentId, policy, familyPolicy = 'off', relaxationFor, reviewHeartbeats = null }) {
  const family = seatFamily(board, agentId);
  return {
    companionWindow: found => companionWindowProblem(board, found),
    notBuilder: (found) => itemAuthorProblem(board, found, agentId, { reviewPatchAuthors, committedItemAuthors, twoTierReviews, strictReviewProblem }),
    routeAllows: (found) => {
      const route = routeOf(board, agentId);
      return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${found.item_id} needs a ${found.item_route} verifier; you joined on the ${route} route`);
    },
    policyAllows: (found) =>
      policy === COORDINATOR && found.item_lane !== COORDINATOR && agentId !== COORDINATOR ? new Refused('COORDINATOR_VERIFIES', 'this repo has the coordinator verify lane work') : null,
    requiredReviewFamily: found => requiredReviewFamilyProblem(board, found, agentId),
    familyAllows: (found) => routingStrictReviewProblem(board, found, agentId) ?? (twoTierReviews(board) ? reviewFamilyProblem(board, found, agentId, relaxationFor && relaxationFor(found) ? 'prefer' : relaxationFor ? frozenFamilyPolicy(found, familyPolicy) : familyPolicy) : familyPolicy === 'require' && (!family || !found.item_builder_family || family === found.item_builder_family)
      ? new Refused('O2_FAMILY_MATCH', `#${found.item_id} needs a verifier from another declared family under verify.family require; ask the coordinator to assign one`)
      : null),
    reviewFree: (found) => {
      const holder = reviewHolder(board, found, reviewHeartbeats);
      return holder && holder !== agentId
        ? new Refused('REVIEW_HELD', `${holder} holds the review of #${found.item_id} until ${found.item_review_until}; take another: pullboard next --verify`)
        : null;
    },
    gateReceipt: (found) => gateReceiptProblem(board, found),
  };
}

/**
 * Refuse unless the acting agent is the coordinator.
 *
 * @param {string} agentId
 * @param {string} what
 */
export function coordinatorOnly(agentId, what) {
  const refusal = onlyCoordinator(agentId, what);
  if (refusal) throw refusal;
}

export { listItems } from "./board/query.js";

export { itemsInStatus } from "./board/query.js";

export { getItem } from "./board/query.js";

export { EVIDENCE_KINDS } from "../logic/board/audience.js";

export { openDecisions } from "./board/query.js";

export { inbox } from "../logic/board/inbox.js";

export { unreadCount } from "./board/query.js";

export { events } from "./board/query.js";

export { FACT_KINDS } from "../../../items/index.js";
export { factReference };

export { itemThread } from "./board/query.js";

/** The enclosing move's transaction owns these implicit notices; older replay emits none. */
export function postRigorNotices(board, trigger) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RIGOR_NOTICE_ENGINE) return;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_AUTO_ENGINE) {
    if (rigorAutoDraftOn(board)) board.nativePorts.recordAutomaticRigorDrafts(board, trigger, persistShout);
    return;
  }
  for (const cause of board.nativePorts.newRigorNotices(events(board), trigger, { person: PERSON })) {
    persistShout(board, { from: 'rigor', to: COORDINATOR, text: board.nativePorts.rigorNoticeText(cause) });
    logEvent(board, 'rigor', 'rigor-notice', null, { cause: cause.key, items: cause.items,
      occurrences: cause.occurrences, neverAgain: cause.neverAgain, engine: RIGOR_NOTICE_ENGINE });
  }
}

export { relatedItems } from "./board/query.js";

export { laneHold, laneHolds } from "./board/query.js";

export { itemHold } from "./board/query.js";

export { rowDrafts } from "./board/query.js";
export { recordSpecApprovalBaseline, specApprovalBaseline, specApprovalBaselineExists } from "./baseline/spec/approval.js";
export { canonicalMilestoneTarget } from "../../../state/light.js";

export { rowDecisions } from "./board/query.js";

export { recentShouts, eventsOfKinds, recentEvents, lastMoves, decisionAndEvidenceShouts, submitInvariantEvents } from "./board/indexes.js";

export { stats } from "../logic/board/stats.js";

export { landingBatches };

/** Tailored inbox activity is the same canonical read projection as other board queries. */
export { agentActivity } from "./board/query.js";

export { rowVerifications } from "../../../spec/index.js";

export { fileTypedRequest, typedRequests, answerTypedRequests } from "./requests.js";

/** Supply the native event clock to the generic item-field writer [M1,C7]. */
export function setItem(board, id, fields, at) { return writeItemFields(board, id, fields, at, now); }

/** Bind foreign blockers to authenticated native received state, never caller status [B24,E32,H16]. */
export function foreignBlockers(board, item) { return readForeignBlockers(board, item, { readReceivedBoardState }); }

/** Project canonical foreign dependency state through the same native receiving reader [B24,E32,H16]. */
export function foreignDependencyStates(board, item) { return readForeignDependencyStates(board, item, { readReceivedBoardState }); }

export { escalate } from "../logic/board/escalate.js";
export { recordAttempt } from "../logic/board/attempt.js";

/** Each move lives in its own module beside this shared plumbing; the board re-exports it for every existing caller [C7]. */
export {
  recordRelayRefusal,
  linkPublishRepair,
  register,
  ensureCoordinator,
  addItem,
  validateItemAddition,
  planCompanion,
  requestCompanion,
  editItem,
  validateItemEdit,
  attachItemPatch,
  objectItemPatch,
  removeItemPatch,
  release,
  submit, prepareSubmit, sealClauseInspection, sealStrictRenames,
  reviewReleaseNoteProblem,
  reviewOffer,
  reserveReview,
  reserveNextReview,
  verify,
  verdictEvidence,
  reopen,
  merged,
  withdraw,
  refreeze,
  shout,
  recordHealthFindings,
  passDecision,
  answerDecision,
  appendFact,
  buildOrder,
  nextFor,
  gateAtHead,
  holdLane,
  releaseLane,
  holdItem,
  releaseItemHold,
  maintainStaleState,
  recordRowDecisions,
  applyRowDecisions,
  recordLandingBatch,
  recordLandingWaiver,
  recordLandingFlake,
  finishLandingBatch,
  intakeOutside,
  applyRehomeItem,
  approveOutside,
  setLaneLead,
  activityDeliveryState,
  activityInterruptWasDelivered,
  recordActivityDelivery,
  actOnActivity,
  openHandoff,
  takeHandoff,
  recordNextIdle,
};


/** Prepare a claim before any outer writer; capability binding stays native and connection-local. */
export function prepareClaim(board, id, options) {
  return preparedClaim(board, id, options, { checkedItemMove, moveItem, reviewerChecks, reviewReleaseCooldown, foreignBlockers });
}

/** Claim with the original guards, retrying stale snapshots caused by concurrent native writes. */
export function claim(board, id, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return applyPreparedClaim(board, id, options, { checkedItemMove, moveItem, reviewerChecks, reviewReleaseCooldown, foreignBlockers });
    } catch (error) {
      if (!(error instanceof Refused) || error.code !== 'BOARD_BUSY' || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(attempt + 1, 5));
    }
  }
}

export { prepareQueueSubmitHandoff, queueSubmitHandoff, startSubmitHandoff, completeSubmitHandoff } from "./submit/handoff/retry.js";

export { createItemSlice } from "./board/item/slice.js";
