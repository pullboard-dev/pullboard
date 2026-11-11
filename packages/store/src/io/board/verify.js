import { REJECT_OPEN_ENGINE } from '../../../../state/index.js';
import { rejectionReturnEnabled } from '../../logic/rework.js';
import { finishVerdict } from "../../../../verify/index.js";
import { rejectionClauseDetail } from "../../../../verify/index.js";
import { rejectionClauseProblem } from "../../../../verify/index.js";
import { requireSourceAdvanceReview } from "../../../../verify/index.js";
import { SOURCE_ADVANCE_ENGINE } from "../../../../state/light.js";
import { itemPatchReviewProblem } from "../../../../items/index.js";
import { outsideSandboxProblem } from "../../../../items/index.js";
import { outsideSource } from "../../../../items/index.js";
import { saveOutsideSource } from "../../../../items/index.js";
import { current } from "./query.js";
import { getItem } from "./query.js";
import { listItems } from "./query.js";
import { requireKnownMainReworks } from '../../logic/known/main/reworks.js';
import { submissionProof } from '../../../../state/index.js';
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from '../../../../state/light.js';
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from '../../../../state/light.js';
import { itemHold } from "./query.js";
import { recordVerdict } from "../../../../verify/index.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { verdictReviewProblem } from "../../../../verify/index.js";
import { firstRefusalDetail } from "../../../../items/index.js";
import { tellFirstRefusal } from "../../../../items/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { VERDICT_REVIEW_ENGINE } from "../../../../state/index.js";
import { IN_STATE } from "../../../../state/index.js";
import { MOVES } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { recordRejectedItemRoute } from "../../../../seats/index.js";
import { causeProblem } from "../../logic/board/rigor.js";
import { tellVerdictImplications } from "../../../../state/index.js";
import { ACCEPT_REASON } from "../board.js";
import { REJECT_REASONS } from "../board.js";
import { moveItem } from "../board.js";
import { escalate } from "../board.js";
import { postRigorNotices } from "../board.js";
import { reviewerChecks } from "../board.js";
import { REVIEW_GATE_RECEIPT_ENGINE } from '../../../../state/light.js';
import { gateReceiptProblem } from '../board.js';
import { reservedRelaxation } from './review/family.js';
import { itemReviewPolicy } from '../../../../verify/index.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../state/light.js';
import { holdItem } from "./hold/item.js";
import { persistShout } from "./shout.js";
import { shout } from "./shout.js";
import { ROUTE_CALIBRATION_ENGINE } from "../../../../state/light.js";
import { listAgents } from './query.js';

/**
 * Record a verdict on submitted work, or a sealed re-review of unlanded work (E8,V1,V3,V8).
 * An accept verifies it; a reject
 * reopens it for rework.
 *
 * The verdict binds the submitted commit and the digest frozen at claim. If the criterion's text
 * has moved since, there is no verdict to give: the coordinator refreezes it and the work is
 * claimed again. The builder never verifies; under `verify: "coordinator"`, lane work is the
 * coordinator's to verify; an agent verifies items at its tier or below, and not while another
 * agent holds the review (V15). An accept means CRITERION_MET and says how it was proved; a reject
 * names one of the reject reasons and says what failed, and may name its cause key for rigor (#713).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, decision: string, reason?: string, note?: string, cause?: string, clause?: string, head: string, digest: string, policy: string, familyPolicy?: string, check?: 'none' | 'green', review?: {commit: string, head?: string, trunk: string, paths: string[]}, implies?: number[], impliesId?: string }} verdict - implies: items this verdict changes (B29)
 * @returns {{ decision: string, reason: string, check?: 'none' | 'green' }}
 */
export function verify(board, id, { agentId, decision, reason, note = '', cause, clause, head, digest, policy, familyPolicy = 'off', check, review, companionDigest, implies, impliesId, reopenFirstRefusalMinutes, environment, sandbox, sourceAdvanceHead, quarantineProofId, knownMainFailures }) {
  const verb = { ACCEPT: 'accept', REJECT: 'reject' }[decision];
  if (!verb) throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  const isAccept = verb === 'accept';
  const code = isAccept ? ACCEPT_REASON : reason;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (sourceAdvanceHead !== undefined && engine < SOURCE_ADVANCE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before binding a verdict to an automatically advanced source');
  board.nativePorts.landingEnvironment.requireVerdict(board, environment);
  const declaration = MOVES.find(move => move.verb === verb);
  const newReview = engine >= VERDICT_REVIEW_ENGINE && review !== undefined;
  let clauseDetail = {};
  // Without the new sealed metadata, old moves keep their exact submitted-only semantics.
  const transition = newReview ? declaration : { ...declaration, from: ['submitted'],
    guards: declaration.guards.filter(guard => !['notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent'].includes(guard)) };
  const suppliedNote = note.trim();
  const reviewHeartbeats = new Map(listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
  return atomic(board, () => {
    const relaxedItem = engine >= REVIEW_FAMILY_RELAX_ENGINE ? getItem(board, id) : null;
    const relaxation = relaxedItem && itemReviewPolicy(board, id).tier === 'standard' ? reservedRelaxation(board, relaxedItem, agentId) : null;
    if (relaxation) note += `\nreview family relaxed at reservation: ${relaxation.queueLength} waiting, threshold ${relaxation.threshold}; active seats: ${relaxation.activeSeats.join(', ') || 'none'}`;
    let proofKnown;
    if (knownMainFailures !== undefined) {
      if (!isAccept || !review || knownMainFailures.main !== review.trunk) throw new Refused('SUBMISSION_PROOF', 'known main failures must match the accepting review trunk');
      const proof = submissionProof({ version: 1, files: [], full: false, deferred: false, reason: '', knownMainFailures }, engine);
      proofKnown = proof.knownMainFailures;
      requireKnownMainReworks(proofKnown, listItems(board, { all: true }), id,
        engine >= KNOWN_MAIN_OWNER_PATTERN_ENGINE, engine >= KNOWN_MAIN_RUNNING_FILE_ENGINE);
    }
    if (quarantineProofId !== undefined) {
      if (!isAccept) throw new Refused('PROOF_RUN_UNBOUND', 'quarantine proof authority only accompanies an accepting verdict');
      const found = getItem(board, id);
      board.nativePorts.quarantine.validateQuarantineProofIds(board, found, { agentId, ids: [quarantineProofId], kind: 'verdict',
        commit: review?.head ?? found.item_commit, requireGreen: true });
    }
    // A verdict with no gate receipt would be recorded as INSUFFICIENT_EVIDENCE and count toward the send-back hold (#3737).
    const pendingGate = engine >= REVIEW_GATE_RECEIPT_ENGINE ? gateReceiptProblem(board, getItem(board, id) ?? {}) : null;
    if (pendingGate) throw pendingGate;
    if (engine >= SOURCE_ADVANCE_ENGINE) requireSourceAdvanceReview(board, getItem(board, id), sourceAdvanceHead);
    const item = moveItem(board, id, verb, {
      transition,
      checks: {
        coordinatorSaysAs: null,
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        atSubmittedCommit: null,
        notMerged: found => !found.item_merged_commit ? null
          : new Refused('ALREADY_MERGED', `item #${id} already landed; only unlanded acceptances can be re-reviewed`),
        verdictReviewRecorded: found => verdictReviewProblem(review, found.item_commit, { checked: engine >= VERDICT_REVIEW_ENGINE }),
        reviewTreeCurrent: null,
        ...reviewerChecks(board, { agentId, policy, familyPolicy, reviewHeartbeats, ...(engine >= REVIEW_FAMILY_RELAX_ENGINE ? { relaxationFor: () => relaxation } : {}) }),
        criterionUnchanged: (found) =>
          digest === found.item_frozen_digest
            ? isAccept ? itemPatchReviewProblem(board, found, companionDigest, { getItem }) : null
            : new Refused('CRITERIA_CHANGED', `the criterion for #${id} changed after it was claimed; the coordinator runs: pullboard refreeze ${id}`),
        reasonIsMet: () => (reason && reason !== ACCEPT_REASON ? new Refused('BAD_REASON', `accept means ${ACCEPT_REASON}; a failed criterion is a reject`) : null),
        trunkMergeClean: null,
        noUnverifiedStack: null, queuedItemLease: null,
        itemCheckGreen: found => isAccept ? outsideSandboxProblem(board, found, sandbox) : null,
        proofRecorded: null, // The native verifier records the gate receipt before this ordered outcome.
        proofNoted: () =>
          suppliedNote
            ? null
            : new Refused('PROOF_REQUIRED', 'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof'),
        reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null : new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`)),
        noteGiven: () => (suppliedNote ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),
        causeWellFormed: () => causeProblem(cause),
        clauseWellFormed: found => isAccept ? null : rejectionClauseProblem(found, clause, engine),
      },
      before: (found) => {
        if (!isAccept) clauseDetail = rejectionClauseDetail(found, clause, engine);
        recordVerdict(board, found, { agentId, decision, reason: code, note, digest, head });
      },
      set: (found) => ({ item_verdict: decision, item_verified_by: isAccept ? agentId : null, item_owner: isAccept ? found.item_owner : null }),
    });
    if (isAccept && sandbox && outsideSource(board, id)) saveOutsideSource(board, id, { ...outsideSource(board, id), sandbox });
    if (!isAccept) {
      // A rejection goes to any eligible seat at once (#2779): from REJECT_OPEN_ENGINE no window is sealed, even when one is passed.
      if (engine >= REJECT_OPEN_ENGINE) reopenFirstRefusalMinutes = 0;
      else if (reopenFirstRefusalMinutes === undefined && rejectionReturnEnabled(board)) reopenFirstRefusalMinutes = 30;
    }
    const trigger = finishVerdict(board, item, { id, isAccept, engine, reopenFirstRefusalMinutes,
      agentId, code, cause, clauseDetail, companionDigest, note, check, quarantineProofId, environment, sandbox, newReview,
      review, implies, impliesId, decision, verb, knownMainFailures: proofKnown }, { firstRefusalDetail, deriveRigorCause: board.nativePorts.deriveRigorCause, logEvent, holdItem,
      shout, tellFirstRefusal, persistShout,
      recordRejectedItemRoute: (target, itemId, moveEngine, item, dependencies) => recordRejectedItemRoute(target, itemId, moveEngine, item,
        { ...dependencies, routeCalibrationEngine: ROUTE_CALIBRATION_ENGINE }),
      escalate, tellVerdictImplications });
    if (!isAccept) postRigorNotices(board, trigger);
    return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}),
      ...(clauseDetail.clause ? { clause: clauseDetail.clause, held: Boolean(itemHold(board, id)) } : {}) };
  });
}
