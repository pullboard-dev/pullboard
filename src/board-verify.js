import * as rejectClause from './reject-clause.js';
import { requireSourceAdvanceReview } from './source-advance-state.js';
import { SOURCE_ADVANCE_ENGINE } from './source-advance-engine.js';
import { itemPatchReviewProblem } from './item-patches.js';
import { outsideSandboxProblem } from './outside-source.js';
import { outsideSource } from './outside-source.js';
import { saveOutsideSource } from './outside-source.js';
import { current } from './board-query.js';
import { getItem } from './board-query.js';
import { itemHold } from './board-query.js';
import { recordVerdict } from './verdict-assurance.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { verdictReviewProblem } from './verdict-reviews.js';
import { firstRefusalDetail } from './claims.js';
import { tellFirstRefusal } from './claims.js';
import { ENGINE_VERSION } from './machine.js';
import { VERDICT_REVIEW_ENGINE } from './machine.js';
import { IN_STATE } from './machine.js';
import { MOVES } from './machine.js';
import * as landingEnvironment from './landing-environment-guards.js';
import { Refused } from './refused.js';
import { recordRejectedItemRoute } from './route-escalation.js';
import { deriveRigorCause } from './rigor-auto.js';
import { causeProblem } from './rigor.js';
import { tellVerdictImplications } from './implies.js';
import { ACCEPT_REASON } from './board.js';
import { REJECT_REASONS } from './board.js';
import { moveItem } from './board.js';
import { escalate } from './board.js';
import { postRigorNotices } from './board.js';
import { reviewerChecks } from './board.js';
import { holdItem } from './board-hold-item.js';
import { persistShout } from './board-shout.js';
import { shout } from './board-shout.js';

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
export function verify(board, id, { agentId, decision, reason, note = '', cause, clause, head, digest, policy, familyPolicy = 'off', check, review, companionDigest, implies, impliesId, reopenFirstRefusalMinutes, environment, sandbox, sourceAdvanceHead }) {
  const verb = { ACCEPT: 'accept', REJECT: 'reject' }[decision];
  if (!verb) throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  const isAccept = verb === 'accept';
  const code = isAccept ? ACCEPT_REASON : reason;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (sourceAdvanceHead !== undefined && engine < SOURCE_ADVANCE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before binding a verdict to an automatically advanced source');
  landingEnvironment.requireVerdict(board, environment);
  const declaration = MOVES.find(move => move.verb === verb);
  const newReview = engine >= VERDICT_REVIEW_ENGINE && review !== undefined;
  let clauseDetail = {};
  // Without the new sealed metadata, old moves keep their exact submitted-only semantics.
  const transition = newReview ? declaration : { ...declaration, from: ['submitted'],
    guards: declaration.guards.filter(guard => !['notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent'].includes(guard)) };
  return atomic(board, () => {
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
        ...reviewerChecks(board, { agentId, policy, familyPolicy }),
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
          note.trim()
            ? null
            : new Refused('PROOF_REQUIRED', 'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof'),
        reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null : new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`)),
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),
        causeWellFormed: () => causeProblem(cause),
        clauseWellFormed: found => isAccept ? null : rejectClause.rejectionClauseProblem(found, clause, engine),
      },
      before: (found) => {
        if (!isAccept) clauseDetail = rejectClause.rejectionClauseDetail(found, clause, engine);
        recordVerdict(board, found, { agentId, decision, reason: code, note, digest, head });
      },
      set: (found) => ({ item_verdict: decision, item_verified_by: isAccept ? agentId : null, item_owner: isAccept ? found.item_owner : null }),
    });
    if (isAccept && sandbox && outsideSource(board, id)) saveOutsideSource(board, id, { ...outsideSource(board, id), sandbox });
    const trigger = rejectClause.finishVerdict(board, item, { id, isAccept, engine, reopenFirstRefusalMinutes,
      agentId, code, cause, clauseDetail, companionDigest, note, check, environment, sandbox, newReview,
      review, implies, impliesId, decision, verb }, { firstRefusalDetail, deriveRigorCause, logEvent, holdItem,
      shout, tellFirstRefusal, persistShout, recordRejectedItemRoute, escalate, tellVerdictImplications });
    if (!isAccept) postRigorNotices(board, trigger);
    return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}),
      ...(clauseDetail.clause ? { clause: clauseDetail.clause, held: Boolean(itemHold(board, id)) } : {}) };
  });
}
