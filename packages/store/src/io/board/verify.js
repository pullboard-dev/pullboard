import { REJECT_OPEN_ENGINE } from '../../../../state/index.js';
import { LANDED_VERDICT_ENGINE } from '../../../../state/index.js';
import { LANDED_REJECT_ENGINE } from '../../../../state/index.js';
import { addItem } from './add.js';
import { sendBackDependents } from './item/after-gate.js';
import { afterGateDependents } from './item/after-gate.js';
import { recordAfterGateRebuild } from './item/after-gate-report.js';
import { recordAfterGateSaved } from './item/after-gate-report.js';
import { reopen } from './reopen.js';
import { release } from './release.js';
import { appendFact } from './fact.js';
import { announceItemState } from './link/announce.js';
import { setItem } from "../board.js";
import { rejectionReturnEnabled } from '../../logic/rework.js';
import { finishVerdict } from "../../../../verify/index.js";
import { rejectionClauseDetail } from "../../../../verify/index.js";
import { rejectionClauseProblem } from "../../../../verify/index.js";
import { requireSourceAdvanceReview } from "../../../../verify/index.js";
import { SOURCE_ADVANCE_ENGINE } from "../../../../state/light.js";
import { checkRouted } from "../../../../items/index.js";
import { itemPatchReviewProblem } from "../../../../items/index.js";
import { vendorOfModel } from "../../../../items/index.js";
import { familyName } from "../../../../verify/index.js";
import { seatFamily } from "../../../../verify/index.js";
import { outsideSandboxProblem } from "../../../../items/index.js";
import { outsideSource } from "../../../../items/index.js";
import { saveOutsideSource } from "../../../../items/index.js";
import { current } from "./query.js";
import { events } from "./query.js";
import { getItem } from "./query.js";
import { listItems } from "./query.js";
import { requireKnownMainReworks } from '../../logic/known/main/reworks.js';
import { submissionProof } from '../../../../state/index.js';
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from '../../../../state/light.js';
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from '../../../../state/light.js';
import { itemHold } from "./query.js";
import { recordVerdict } from "../../../../verify/index.js";
import { writeBoardMeta } from "./meta.js";
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
import { relaxationRecordLine } from './review/family.js';
import { verdictRelaxableTier } from './review/family.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../state/light.js';
import { holdItem } from "./hold/item.js";
import { persistShout } from "./shout.js";
import { shout } from "./shout.js";
import { ROUTE_CALIBRATION_ENGINE } from "../../../../state/light.js";
import { listAgents } from './query.js';
import { measureBoardWritePhase } from './write/lock.js';
import { endReviewLease } from './review/lease.js';
import { applyVerdict } from './verify-table.js';
import { verifyDecision } from './verify-table.js';
import { readVerifyFacts } from './verify-table.js';
import { pipelineCause } from "../../../../kernel/index.js";
import { frozenBar } from "../../../../verify/index.js";
import { namedClause } from "../../../../verify/index.js";
import { wording } from "../../../../verify/index.js";
import { AUTO_ESCALATE_ENGINE } from "../../../../state/light.js";
import { NATIVE_FLAKE_ENGINE } from "../../../../state/light.js";
import { REJECT_CLAUSE_ENGINE } from "../../../../state/light.js";
import { REOPEN_FIRST_REFUSAL_ENGINE } from "../../../../state/light.js";
import { REVIEW_REQUEST_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { SPEC_APPROVAL_ENGINE } from "../../../../state/light.js";
import { STRONG_REJECTION_NOTICE_ENGINE } from "../../../../state/light.js";
import { itemPace } from "./sprint-pace.js";
import { landedSprintPullOut } from "./sprint-pull-out.js";
import { queueSprintPullOut } from "./sprint-pull-out.js";

/** What the verify table needs from the cells the writer already reads; the table decides a verdict only from the engine where every rule it holds was in force. */
const VERIFY_TABLE_DEPS = Object.freeze({ pipelineCause, frozenBar, namedClause, wording, seatFamily, nativeFlakeEngine: NATIVE_FLAKE_ENGINE, strongNoticeEngine: STRONG_REJECTION_NOTICE_ENGINE,
  from: Math.max(VERDICT_REVIEW_ENGINE, REVIEW_REQUEST_ENGINE, REJECT_CLAUSE_ENGINE, REJECT_OPEN_ENGINE, REOPEN_FIRST_REFUSAL_ENGINE, RIGOR_AUTO_ENGINE, SPEC_APPROVAL_ENGINE,
    AUTO_ESCALATE_ENGINE, STRONG_REJECTION_NOTICE_ENGINE, ROUTE_CALIBRATION_ENGINE, NATIVE_FLAKE_ENGINE) });

/**
 * The item with its builder family read from its claim events when it never recorded a builder or a family.
 * Why: forced landings leave item_built_by empty, so verify.family require could not tell the builder's family and
 * refused every reviewer. A reviewer whose family is among the claimers' families is checked against that family, so the
 * same-family refusal holds; otherwise any claimer's family stands in [V1].
 */
function withClaimedBuilderFamily(board, item, agentId) {
  if (item.item_built_by || String(item.item_builder_family ?? '').trim()) return item;
  const families = [];
  for (const event of events(board, { itemId: item.item_id })) {
    if (event.event_kind !== 'claim') continue;
    const family = vendorOfModel(JSON.parse(event.event_detail || '{}').model);
    if (family && !families.includes(family)) families.push(family);
  }
  const reviewer = familyName(seatFamily(board, agentId));
  const family = families.includes(reviewer) ? reviewer : families[0];
  return family ? { ...item, item_builder_family: family } : item;
}

/**
 * The evidence a verdict names: known-main failures and a quarantine proof. With `enforce` false the slow reads (every item,
 * the proof's runs) are skipped and only the pure parse runs; the command already ran them with no lock held [#5576].
 *
 * @returns {object | undefined} The parsed known-main failures, for the verdict's record.
 */
export function verdictEvidence(board, id, { agentId, isAccept, engine, review, knownMainFailures, quarantineProofId, enforce = true }) {
  let proofKnown;
  if (knownMainFailures !== undefined) {
    if (!isAccept || !review || knownMainFailures.main !== review.trunk) throw new Refused('SUBMISSION_PROOF', 'known main failures must match the accepting review trunk');
    const proof = submissionProof({ version: 1, files: [], full: false, deferred: false, reason: '', knownMainFailures }, engine);
    proofKnown = proof.knownMainFailures;
    if (enforce) measureBoardWritePhase(board.db, 'verify-known-main', () => requireKnownMainReworks(proofKnown, listItems(board, { all: true }), id,
      engine >= KNOWN_MAIN_OWNER_PATTERN_ENGINE, engine >= KNOWN_MAIN_RUNNING_FILE_ENGINE));
  }
  if (quarantineProofId !== undefined) {
    if (!isAccept) throw new Refused('PROOF_RUN_UNBOUND', 'quarantine proof authority only accompanies an accepting verdict');
    if (enforce) {
      const found = getItem(board, id);
      board.nativePorts.quarantine.validateQuarantineProofIds(board, found, { agentId, ids: [quarantineProofId], kind: 'verdict',
        commit: review?.head ?? found.item_commit, requireGreen: true });
    }
  }
  return proofKnown;
}

/**
 * The reads the verify table needs for this verdict (the item's history and verdicts, the seat's route and flakes, the next ids), taken with no lock held.
 * Why: they depend on no write of this verdict, so the writer decides from them while its guard still matches the board and holds the lock only to write [#10868].
 *
 * @returns {object | undefined} The prepared facts, or undefined when the table does not model this call.
 */
export function prepareVerdictFacts(board, id, { agentId, review }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < VERDICT_REVIEW_ENGINE || review === undefined) return undefined;
  const item = getItem(board, id);
  if (!item || !item.item_built_by) return undefined;
  return readVerifyFacts(board, item, agentId, VERIFY_TABLE_DEPS) ?? undefined;
}

/**
 * Record a verdict on submitted work, or a sealed re-review of unlanded work (E8,V1,V3,V8).
 * An accept verifies it; a reject
 * reopens it for rework.
 *
 * The verdict binds the submitted commit and the digest frozen at claim. If the criterion's text
 * has moved since, there is no verdict to give: the coordinator refreezes it and the work is
 * claimed again. The builder never verifies, except by the solo low-stakes accept the verify table writes (`soloLowStakes`, `rows` and `checks`, #966); under `verify: "coordinator"`, lane work is the
 * coordinator's to verify; an agent verifies items at its tier or below, and not while another
 * agent holds the review (V15). An accept means CRITERION_MET and says how it was proved; a reject
 * names one of the reject reasons and says what failed, and may name its cause key for rigor (#713).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, decision: string, reason?: string, note?: string, cause?: string, clause?: string, head: string, digest: string, policy: string, familyPolicy?: string, check?: 'none' | 'green', review?: {commit: string, head?: string, trunk: string, paths: string[]}, implies?: number[], impliesId?: string }} verdict - implies: items this verdict changes (B29)
 * @returns {{ decision: string, reason: string, check?: 'none' | 'green' }}
 */
export function verify(board, id, { agentId, decision, reason, note = '', cause, clause, head, digest, policy, familyPolicy = 'off', landed, keepCheck, check, review, companionDigest, implies, impliesId, reopenFirstRefusalMinutes, environment, sandbox, sourceAdvanceHead, quarantineProofId, knownMainFailures, prechecked = false, verifyFacts, soloLowStakes, rows, checks, isolated }) {
  const verb = { ACCEPT: 'accept', REJECT: 'reject' }[decision];
  if (!verb) throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  const isAccept = verb === 'accept';
  const code = isAccept ? ACCEPT_REASON : reason;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (landed === true) return landedVerdict(board, id, { agentId, isAccept, decision, code, reason, note, policy, familyPolicy, engine, keepCheck: keepCheck === true });
  if (sourceAdvanceHead !== undefined && engine < SOURCE_ADVANCE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before binding a verdict to an automatically advanced source');
  board.nativePorts.landingEnvironment.requireVerdict(board, environment);
  const declaration = MOVES.find(move => move.verb === verb);
  const newReview = engine >= VERDICT_REVIEW_ENGINE && review !== undefined;
  let clauseDetail = {};
  // Without the new sealed metadata, old moves keep their exact submitted-only semantics.
  const transition = newReview ? declaration : { ...declaration, from: ['submitted'],
    guards: declaration.guards.filter(guard => !['notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent'].includes(guard)) };
  const suppliedNote = note.trim();
  const givenNote = note;
  const reviewHeartbeats = new Map(listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
  return atomic(board, () => {
    const relaxedItem = engine >= REVIEW_FAMILY_RELAX_ENGINE ? getItem(board, id) : null;
    const relaxation = measureBoardWritePhase(board.db, 'verify-relaxation', () => relaxedItem && verdictRelaxableTier(board, relaxedItem) ? reservedRelaxation(board, relaxedItem, agentId) : null);
    const relaxationLine = relaxation ? relaxationRecordLine(board, relaxedItem, agentId, relaxation) : null;
    if (relaxation) note += `\n${relaxationLine}`;
    const proofKnown = verdictEvidence(board, id, { agentId, isAccept, engine, review, knownMainFailures, quarantineProofId, enforce: !prechecked });
    // A verdict with no gate receipt would be recorded as INSUFFICIENT_EVIDENCE and count toward the send-back hold (#3737).
    const pendingGate = engine >= REVIEW_GATE_RECEIPT_ENGINE ? measureBoardWritePhase(board.db, 'verify-gate-receipt', () => gateReceiptProblem(board, getItem(board, id) ?? {})) : null;
    if (pendingGate) throw pendingGate;
    if (engine >= SOURCE_ADVANCE_ENGINE) requireSourceAdvanceReview(board, getItem(board, id), sourceAdvanceHead);
    // The verify table decides the verdict event and its follow-ups from the board before the move; where it does not model the call, the original rules below run.
    const decided = newReview ? verifyDecision(board, getItem(board, id), { agentId, decision, reason, note: givenNote, soloLowStakes, rows, checks, relaxation: relaxation ? relaxationLine : null, cause, clause, head, digest, review,
      companionDigest, implies, environment, sandbox, sourceAdvanceHead, quarantineProofId, check, knownMainFailures: proofKnown, engine }, VERIFY_TABLE_DEPS, verifyFacts) : null;
    // A builder's own accept passes the notBuilder check only when the verify table, through soloLowStakesHolds, wrote the solo-low-stakes-accept event for it [#966].
    const soloEvents = isAccept ? decided?.events.filter(event => event.kind === 'solo-low-stakes-accept') ?? [] : [];
    const soloAccepted = soloEvents.length > 0;
    // A reject of landed sprint work queues its pull-out; read before the move, and only for a sprint item, so steady and strict read nothing more [M2,#12181].
    const pullOut = isAccept ? null : landedSprintPullOut(board, getItem(board, id));
    const item = moveItem(board, id, verb, {
      transition,
      checks: {
        coordinatorSaysAs: null,
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        atSubmittedCommit: null,
        // Sprint lands submitted work before its verdict, so only steady and strict items refuse a landed one, as the verify table's not-merged guard says [#12180].
        notMerged: found => !found.item_merged_commit || itemPace(found) === 'sprint' ? null
          : new Refused('ALREADY_MERGED', `item #${id} already landed; only unlanded acceptances can be re-reviewed`),
        verdictReviewRecorded: found => verdictReviewProblem(review, found.item_commit, { checked: engine >= VERDICT_REVIEW_ENGINE }),
        reviewTreeCurrent: null,
        ...reviewerChecks(board, { agentId, policy, familyPolicy, reviewHeartbeats, soloLowStakes: soloAccepted, ...(engine >= REVIEW_FAMILY_RELAX_ENGINE ? { relaxationFor: () => relaxation } : {}) }),
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
        // Whether the check ran isolated from the reviewer's checkout is recorded beside the verdict, only when the caller says so [C7,#1112].
        if (typeof isolated === 'boolean') {
          const verdictId = board.db.prepare('SELECT MAX(verdict_id) AS id FROM verdict WHERE item_id=?').get(id).id;
          writeBoardMeta(board.db, `verdict_isolated:${verdictId}`, String(isolated));
        }
        // The verified proof trigger reads this event when the item row moves to verified, so it is written with the verdict, ahead of the move [#966].
        for (const event of soloEvents) logEvent(board, event.by, event.kind, id, event.detail);
      },
      set: (found) => ({ item_verdict: decision, item_verified_by: isAccept ? agentId : null, item_owner: isAccept ? found.item_owner : null }),
    });
    endReviewLease(board, id);
    if (isAccept && sandbox && outsideSource(board, id)) saveOutsideSource(board, id, { ...outsideSource(board, id), sandbox });
    if (!isAccept) {
      // A rejection goes to any eligible seat at once (#2779): from REJECT_OPEN_ENGINE no window is sealed, even when one is passed.
      if (engine >= REJECT_OPEN_ENGINE) reopenFirstRefusalMinutes = 0;
      else if (reopenFirstRefusalMinutes === undefined && rejectionReturnEnabled(board)) reopenFirstRefusalMinutes = 30;
    }
    const trigger = decided ? measureBoardWritePhase(board.db, 'verify-finish', () => {
      const logged = applyVerdict(board, id, decided.events.filter(event => !soloEvents.includes(event)), { logEvent, holdItem, shout, escalate });
      tellVerdictImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), id, { seed: impliesId, implies });
      return logged;
    }) : measureBoardWritePhase(board.db, 'verify-finish', () => finishVerdict(board, item, { id, isAccept, engine, reopenFirstRefusalMinutes,
      agentId, code, cause, clauseDetail, companionDigest, note, check, quarantineProofId, environment, sandbox, newReview,
      review, implies, impliesId, decision, verb, knownMainFailures: proofKnown }, { firstRefusalDetail, deriveRigorCause: board.nativePorts.deriveRigorCause, logEvent, holdItem,
      shout, tellFirstRefusal, persistShout,
      recordRejectedItemRoute: (target, itemId, moveEngine, item, dependencies) => recordRejectedItemRoute(target, itemId, moveEngine, item,
        { ...dependencies, routeCalibrationEngine: ROUTE_CALIBRATION_ENGINE }),
      escalate, tellVerdictImplications }));
    // The verify table writes the pull_out itself when it decides; where it does not model the call, the writer queues it here.
    if (pullOut && !decided) queueSprintPullOut(board, id, pullOut, { reason: code });
    if (!isAccept) postRigorNotices(board, trigger);
    // The dependents built on a rejected after-gate parent go back with it [C7,#11807].
    if (!isAccept) sendBackDependents(board, id, { cause }, { reopen, release, appendFact, recordAfterGateRebuild });
    // A verified after-gate parent records the minutes its dependents built meanwhile [C7,#12326].
    if (isAccept) recordAfterGateSaved(board, id, afterGateDependents(board, id), { agentId });
    return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}),
      ...(clauseDetail.clause ? { clause: clauseDetail.clause, held: Boolean(itemHold(board, id)) } : {}) };
  });
}

/**
 * The route, criterion, brief and check of the follow-up a landed reject files.
 * A mid or light parent passes its Files:, Test: and check on, so the follow-up is buildable cold; when the parent lacks any of them
 * the follow-up is routed strong, which needs no brief, so the verdict always records.
 * Why: a mid follow-up with only the review note as its brief refused NO_BRIEF and rolled back the whole verdict [#8835].
 *
 * @param {any} found - The landed item row.
 * @returns {{ route: string, criterion: string, brief: string, check?: string }}
 */
function landedFollowUpBar(found, id, reason, note, engine) {
  const criterion = `1. The ${reason} that review found in landed #${id} is fixed on main: ${note} [reasoning]`;
  const review = `Landed #${id} at ${found.item_merged_commit} was rejected after landing (${reason}). Builder: ${found.item_built_by ?? 'unknown'}. Review note: ${note}`;
  const route = found.item_route ?? 'strong';
  const check = found.item_check ?? '';
  if (route !== 'strong' && check.trim() && String(found.item_brief ?? '').trim()) {
    const brief = `${review}\n\n${String(found.item_brief).trim()}`;
    try {
      checkRouted({ brief, route, criterion, check }, engine);
      return { route, criterion, brief, check };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
  }
  return { route: 'strong', criterion, brief: review };
}

/** When the recorded move argument keepCheck is true, the follow-up may carry its parent's exact check; the move reads no machine setting [#9637]. */
function followUpCheck(found, bar, keepCheck) {
  return keepCheck && bar.check !== undefined && bar.check === found.item_check ? { ...bar, keptCheckFrom: found.item_check } : bar;
}

/**
 * Record a verdict on an item a forced merge landed around the gate with no review (V1).
 * An accept is recorded as a verdict and the landing stays: the item keeps its status and merged commit.
 * Why: hand landings had no second look, and verify refused them as not submitted [V1,H16].
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, isAccept: boolean, decision: string, code: string, reason?: string, note: string, policy: string, familyPolicy: string, engine: number }} verdict
 * @returns {{ decision: string, reason: string }}
 */
function landedVerdict(board, id, { agentId, isAccept, decision, code, reason, note, policy, familyPolicy, engine, keepCheck = false }) {
  if (engine < LANDED_VERDICT_ENGINE) throw new Refused('ENGINE_VERSION', `a verdict on a forced landing requires engine ${LANDED_VERDICT_ENGINE}; upgrade Pullboard before recording one`);
  if (!isAccept && engine < LANDED_REJECT_ENGINE) throw new Refused('ENGINE_VERSION', `a reject on a landed item requires engine ${LANDED_REJECT_ENGINE}; upgrade Pullboard before recording one`);
  const suppliedNote = note.trim();
  return atomic(board, () => {
    const found = getItem(board, id);
    const forced = found && found.item_merged_commit && found.item_status === 'withdrawn'
      && events(board, { itemId: id }).some(event => event.event_kind === 'merged' && JSON.parse(event.event_detail || '{}').forced === true);
    if (!forced) throw new Refused('NOT_LANDED', `item #${id} is ${found?.item_status}, not landed by a forced merge: pullboard show ${id}`);
    const checks = reviewerChecks(board, { agentId, policy, familyPolicy });
    const judged = withClaimedBuilderFamily(board, found, agentId);
    for (const guard of ['notBuilder', 'routeAllows', 'policyAllows', 'requiredReviewFamily', 'familyAllows', 'reviewFree']) {
      const refusal = checks[guard](judged);
      if (refusal) throw refusal;
    }
    if (!isAccept) {
      if (!reason || !REJECT_REASONS.includes(reason)) throw new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`);
      if (!suppliedNote) throw new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."');
    }
    if (isAccept && reason && reason !== ACCEPT_REASON) throw new Refused('BAD_REASON', `accept means ${ACCEPT_REASON}; a failed criterion is a reject`);
    if (isAccept && !suppliedNote) throw new Refused('PROOF_REQUIRED', 'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof');
    recordVerdict(board, { ...found, item_commit: found.item_commit ?? found.item_merged_commit }, { agentId, decision, reason: code, note, digest: found.item_frozen_digest ?? '', head: found.item_merged_commit });
    setItem(board, id, { item_verdict: decision, item_verified_by: agentId });
    // A landed item cannot move back, so a reject opens a follow-up item in its lane for the builder to fix.
    const followUp = isAccept ? null : addItem(board, { by: agentId, lane: found.item_lane, title: `Fix after review of #${id}: ${found.item_title}`.slice(0, 120),
      specIds: [], parentId: null, after: [], ...followUpCheck(found, landedFollowUpBar(found, id, reason, suppliedNote, engine), keepCheck) });
    logEvent(board, agentId, 'verify', id, { reason: code, commit: found.item_merged_commit, landed: true, note: suppliedNote, ...(followUp ? { followUp } : {}), ...(followUp && keepCheck && found.item_check && getItem(board, followUp)?.item_check === found.item_check ? { keptCheckFrom: found.item_check } : {}) });
    return { decision, reason: code, ...(followUp ? { followUp } : {}) };
  });
}

/**
 * Tell the parent boards that wait on a verified item its new state, after the verdict has been recorded.
 * Why: the verdict is a replayed move and cannot carry a transport, so the command passes the link ports here after the move; a failed delivery stays queued for resendPendingBoardStates and never undoes the verdict [E32,B24].
 *
 * @param {any} board
 * @param {number} id
 * @param {{ links: object[] }} ports
 */
export async function announceVerdict(board, id, ports) {
  return announceItemState(board, id, ports);
}
