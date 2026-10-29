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
import { committedItemAuthors } from './review-independence.js';
import { strictReviewProblem } from './review-independence.js';
import * as reviewRouting from './review-routing.js';
import { reviewFamilyProblem } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { setItem as writeItemFields } from './item-fields.js';
import { foreignBlockers as readForeignBlockers } from './cross-repo-dependencies.js';
import { foreignDependencyStates as readForeignDependencyStates } from './cross-repo-dependencies.js';
import { readReceivedBoardState } from './board-link-state.js';
import * as reviewFamilies from './required-review-family.js';
import { laneLeads } from './lane-lead.js';
import { PERSON } from './board-query.js';
import { now } from './board-query.js';
import { current } from './board-query.js';
import { reviewReleasesSinceSubmit } from './board-query.js';
import { itemById } from './board-query.js';
import { reviewHolder } from './board-query.js';
import { events } from './board-query.js';
import { prepareMergeOnlySubmit } from './merge-only-submit.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { verdictReviewProblem } from './verdict-reviews.js';
import { verdictsFor } from './verdict-reviews.js';
import { acceptedVerdict } from './verdict-reviews.js';
import { checkedLandingCommit } from './verdict-reviews.js';
import { itemFiles } from './item-files.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { GUARDS } from './machine.js';
import { IN_STATE } from './machine.js';
import { MOVES } from './machine.js';
import { STATES } from './machine.js';
import { UNKNOWN_MOVE } from './machine.js';
import { effectiveGuards } from './machine.js';
import { Refused } from './refused.js';
import { itemAuthorProblem } from './item-authors.js';
import { ROUTES } from './route-escalation.js';
import { canTake } from './route-escalation.js';
import { routeOf } from './seats.js';
import { newRigorNotices } from './rigor-notices.js';
import { rigorNoticeText } from './rigor-notices.js';
import { RIGOR_NOTICE_ENGINE } from './rigor-source.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';
import { recordAutomaticRigorDrafts } from './rigor-auto.js';
import { factReference } from './fact-reference.js';
import { landingFlakes } from './landing-exceptions.js';
import { landingWaiverCovers } from './landing-exceptions.js';
import { landingWaiverKind } from './landing-exceptions.js';
import { landingBatches } from './landing-batch-history.js';
import { recordRelayRefusal } from './board-relay-refusal.js';
import { linkPublishRepair } from './board-publish-repair.js';
import { register } from './board-register.js';
import { ensureCoordinator } from './board-ensure-coordinator.js';
import { addItem } from './board-add-item.js';
import { validateItemAddition } from './board-add-item.js';
import { planCompanion } from './board-request-companion.js';
import { requestCompanion } from './board-request-companion.js';
import { editItem } from './board-edit-item.js';
import { validateItemEdit } from './board-edit-item.js';
import { attachItemPatch } from './board-attach-item-patch.js';
import { removeItemPatch } from './board-remove-item-patch.js';
import { claim } from './board-claim.js';
import { release } from './board-release.js';
import { submit } from './board-submit.js';
import { reviewReleaseNoteProblem } from './board-review-release-note.js';
import { reviewOffer } from './board-review-offer.js';
import { reserveReview } from './board-reserve-review.js';
import { reserveNextReview } from './board-reserve-next-review.js';
import { verify } from './board-verify.js';
import { reopen } from './board-reopen.js';
import { merged } from './board-merged.js';
import { withdraw } from './board-withdraw.js';
import { refreeze } from './board-refreeze.js';
import { shout } from './board-shout.js';
import { recordHealthFindings } from './board-record-health-findings.js';
import { passDecision } from './board-pass-decision.js';
import { answerDecision } from './board-answer-decision.js';
import { appendFact } from './board-append-fact.js';
import { buildOrder } from './board-build-order.js';
import { nextFor } from './board-next-for.js';
import { holdLane } from './board-hold-lane.js';
import { releaseLane } from './board-release-lane.js';
import { holdItem } from './board-hold-item.js';
import { releaseItemHold } from './board-release-item-hold.js';
import { maintainStaleState } from './board-maintain-stale-state.js';
import { recordRowDecisions } from './board-record-row-decisions.js';
import { applyRowDecisions } from './board-apply-row-decisions.js';
import { recordLandingBatch } from './board-record-landing-batch.js';
import { recordLandingWaiver } from './board-record-landing-waiver.js';
import { recordLandingFlake } from './board-record-landing-flake.js';
import { finishLandingBatch } from './board-finish-landing-batch.js';
import { intakeOutside } from './board-intake-outside.js';
import { applyRehomeItem } from './board-apply-rehome-item.js';
import { approveOutside } from './board-approve-outside.js';
import { setLaneLead } from './board-set-lane-lead.js';
import { activityDeliveryState } from './board-activity-delivery.js';
import { recordActivityDelivery } from './board-activity-delivery.js';
import { actOnActivity } from './board-act-on-activity.js';
import { openHandoff } from './board-open-handoff.js';
import { takeHandoff } from './board-take-handoff.js';
import { recordNextIdle } from './board-record-next-idle.js';
import { persistShout } from './board-shout.js';
export { advanceItemSource } from './source-advance.js';
export { recordTrainLanding } from './record-train-landing.js';
export { laneLeads };

export { itemPatches, itemPatchDigest, followItemPatches } from './item-patches.js';
export { readBoardMembers, setBoardMembers } from './board-members.js';
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
} from './board-read-auxiliary.js';
export { lineSettings } from '../packages/state/src/core/line-settings-read.js';
export { setLineSetting } from './line-settings.js';

export {
  itemRedirect,
  rehomeDestinationItemId,
  rehomeImport,
  rehomeItem,
  reserveRehomeItemId,
} from './board-rehome.js';
export { setBarReady, signBar } from './bar-readiness.js';
export { coordinatorCheck, completeCheckBaseline, itemCheckAuthor } from './item-check-baseline.js';

export { atomic, logEvent };
export { verdictReviewProblem, verdictsFor, acceptedVerdict, checkedLandingCommit };
export { landingTestDefects, recordLandingTestDefect } from './landing-test-defects.js';
export { landingLeaseMove, landingLeaseState } from './landing-lease.js';
export { boardBusyError } from './board-access.js';
export { schemaMissing, writeRefused } from './board-migrate.js';
export { itemFiles };
export { ROUTES, canTake };
export { landingFlakes, landingWaiverCovers, landingWaiverKind };
export { landingWaivers, landingWaiverFor, waivedLandingProof } from './landing-waivers.js';
export { acceptCheck } from './check-accept.js';
export { declareJob, recordJobRun } from './recurring-jobs.js';
export { proposeSentinel, decideSentinel, beginSentinelRun, finishSentinelRun } from './sentinels.js';
export { flakeLedger, recordFlakeObservation } from './flakes.js';
export { flakeQuarantines, gateRuns, recordGateRun } from './quarantine.js';
export { personProposals, personSigning, proposePersonMove, setPersonSigning } from './person-signing.js'; // Signed person moves [E22].
export { recordUsage } from './cost.js';
export { recordSharedUsage } from './cost-shared.js';
export { proofReceipts, recordProofRun } from './proof-receipts.js';
export { recordPublishFinding } from './pr-findings.js';
/** The seat readers live in seats.js; the board re-exports them so `store.*` callers keep one import. */
export { agentAt, agentById, agentCreator, coordinatorHolder, listAgents, nextSeatId, seatEnrolled, seatLineage, takeCoordinator, withVerifierStanding } from './seats.js';

export const ACCEPT_REASON = 'CRITERION_MET';
export { PERSON } from './board-query.js';

export { EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION, BOARD_BUSY_TIMEOUT_MS, SCHEMA_VERSION } from './board-schema-source.js';

const REVIEW_RELEASE_COOLDOWN_MS = 60 * 60 * 1000;

export const REJECT_REASONS = [
  'TEST_FAILURE',
  'BEHAVIOR_MISMATCH',
  'INSUFFICIENT_EVIDENCE',
  'STALE_HEAD',
  'OTHER',
];

export { systemClock } from './board-read-open.js';

export { openBoardForRead } from './native-board.js';

export { openBoardReadOnly } from './board-read-open.js';
/** Temporary public compatibility; #1624 removes this edge after native-root callers compose. */
export { openBoard } from './native-board.js';

export { readEventLogVersion } from './board-read-open.js';

export { boardId } from './board-query.js';

export { closeBoard } from './board-read-open.js';

export { itemById } from './board-query.js';

/**
 * The refusal codes src/machine.js declares for a guard of a move: the guard's own and any
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

/**
 * Apply one declared move to an item (M1, M2). This is the only code that writes an item's status.
 *
 * It checks the move's guards, then any exit guard of its target the move does not name, in the
 * order src/machine.js declares them, and refuses with the first that does not hold. `checks` has
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

export { reviewHolder } from './board-query.js';

/** Return a reviewer's active one-hour cooldown, if a later submission has not reset it [V1,R1]. */
export const reviewReleaseCooldown = (board, itemId, agentId) => reviewRouting.reviewReleaseCooldown(board, itemId, agentId, { engineVersion: ENGINE_VERSION, reviewReleasesSinceSubmit, cooldownMs: REVIEW_RELEASE_COOLDOWN_MS });

export { reviewQueueBreakdown } from './board-query.js';

export { reviewQueue } from './board-query.js';

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
export function reviewerChecks(board, { agentId, policy, familyPolicy = 'off' }) {
  const family = reviewRouting.seatFamily(board, agentId);
  return {
    notBuilder: (found) => itemAuthorProblem(board, found, agentId, { committedItemAuthors, twoTierReviews, strictReviewProblem }),
    routeAllows: (found) => {
      const route = routeOf(board, agentId);
      return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${found.item_id} needs a ${found.item_route} verifier; you joined on the ${route} route`);
    },
    policyAllows: (found) =>
      policy === COORDINATOR && found.item_lane !== COORDINATOR && agentId !== COORDINATOR ? new Refused('COORDINATOR_VERIFIES', 'this repo has the coordinator verify lane work') : null,
    requiredReviewFamily: found => reviewFamilies.requiredReviewFamilyProblem(board, found, agentId),
    familyAllows: (found) => reviewRouting.strictReviewProblem(board, found, agentId) ?? (twoTierReviews(board) ? reviewFamilyProblem(board, found, agentId, familyPolicy) : familyPolicy === 'require' && (!family || !found.item_builder_family || family === found.item_builder_family)
      ? new Refused('O2_FAMILY_MATCH', `#${found.item_id} needs a verifier from another declared family under verify.family require; ask the coordinator to assign one`)
      : null),
    reviewFree: (found) => {
      const holder = reviewHolder(board, found);
      return holder && holder !== agentId
        ? new Refused('REVIEW_HELD', `${holder} holds the review of #${found.item_id} until ${found.item_review_until}; take another: pullboard next --verify`)
        : null;
    },
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

export { listItems } from './board-query.js';

export { itemsInStatus } from './board-query.js';

export { getItem } from './board-query.js';

export { EVIDENCE_KINDS } from './shout-audience.js';

export { openDecisions } from './board-query.js';

export { inbox } from './inbox-store.js';

export { unreadCount } from './board-query.js';

export { events } from './board-query.js';

export { FACT_KINDS } from './item-notes.js';
export { factReference };

export { itemThread } from './board-query.js';

/** The enclosing move's transaction owns these implicit notices; older replay emits none. */
export function postRigorNotices(board, trigger) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RIGOR_NOTICE_ENGINE) return;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_AUTO_ENGINE) {
    recordAutomaticRigorDrafts(board, trigger, persistShout);
    return;
  }
  for (const cause of newRigorNotices(events(board), trigger, { person: PERSON })) {
    persistShout(board, { from: 'rigor', to: COORDINATOR, text: rigorNoticeText(cause) });
    logEvent(board, 'rigor', 'rigor-notice', null, { cause: cause.key, items: cause.items,
      occurrences: cause.occurrences, neverAgain: cause.neverAgain, engine: RIGOR_NOTICE_ENGINE });
  }
}

export { relatedItems } from './board-query.js';

export { laneHold, laneHolds } from './board-query.js';

export { itemHold } from './board-query.js';

export { rowDrafts } from './board-query.js';
export { draftSpecRow, decideSpecRevisions, recordRowVerification } from './native-board.js';
export { recordSpecApprovalBaseline, specApprovalBaseline, specApprovalBaselineExists } from './spec-approval-baseline.js';
// Temporary milestone composition edge under #1776; remove this facade when its declared public contract expires.
export { addMilestone, editMilestone, editMilestoneItems, orderMilestoneItems, moveMilestone, removeMilestone, roadmap, shipMilestone } from './board-milestones.js';
export { canonicalMilestoneTarget } from '../packages/state/src/core/milestone-target.js';

export { rowDecisions } from './board-query.js';

export { recentShouts, eventsOfKinds, recentEvents, lastMoves, decisionAndEvidenceShouts, submitInvariantEvents } from './board-hot.js';

export { stats } from './board-stats.js';

export { landingBatches };

/** Tailored inbox activity is the same canonical read projection as other board queries. */
export { agentActivity } from './board-query.js';

export { rowVerifications } from './spec-verdicts.js';

export { fileTypedRequest, typedRequests, answerTypedRequests } from './typed-requests.js';

/** Supply the native event clock to the generic item-field writer [M1,C7]. */
export function setItem(board, id, fields, at) { return writeItemFields(board, id, fields, at, now); }

/** Bind foreign blockers to authenticated native received state, never caller status [B24,E32,H16]. */
export function foreignBlockers(board, item) { return readForeignBlockers(board, item, { readReceivedBoardState }); }

/** Project canonical foreign dependency state through the same native receiving reader [B24,E32,H16]. */
export function foreignDependencyStates(board, item) { return readForeignDependencyStates(board, item, { readReceivedBoardState }); }

export { escalate } from './board-escalate.js';
export { recordAttempt } from './board-record-attempt.js';

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
  removeItemPatch,
  claim,
  release,
  submit,
  reviewReleaseNoteProblem,
  reviewOffer,
  reserveReview,
  reserveNextReview,
  verify,
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
  recordActivityDelivery,
  actOnActivity,
  openHandoff,
  takeHandoff,
  recordNextIdle,
};
