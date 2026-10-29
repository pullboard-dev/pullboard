import { verdictWithdrawalTarget } from './verdict-withdrawal.js';
import { sourceAdvanceReturnProblem } from './source-advance-return.js';
import { reopenAuthority } from './reopen-authority.js';
import * as verdictWithdrawal from './verdict-withdrawal.js';
import { current } from './board-query.js';
import { getItem } from './board-query.js';
import { events } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { manualLandingFailure } from './claims.js';
import { firstRefusalDetail } from './claims.js';
import { tellFirstRefusal } from './claims.js';
import { manualLandingFailureQuoted } from '../packages/state/src/core/manual-landing-failure-quoted.js';
import { ENGINE_VERSION } from './machine.js';
import { QUOTED_LANDING_FAILURE_ENGINE } from './machine.js';
import { REOPEN_FIRST_REFUSAL_ENGINE } from './machine.js';
import { IN_STATE } from './machine.js';
import { MOVES } from './machine.js';
import { Refused } from './refused.js';
import { listAgents } from './seats.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';
import { causeProblem } from './board-rigor.js';
import { conflictDetail } from './trunk-conflict.js';
import { conflictProblem } from './trunk-conflict.js';
import { returnedHeadNotice } from './trunk-conflict.js';
import { conflictNote } from '../packages/kernel/src/core/registry-guards.js';
import { landingBatches } from './git-landing-batches.js';
import { moveItem } from './board.js';
import { postRigorNotices } from './board.js';
import { persistShout } from './board-shout.js';

/** Return a submission for correction, or a verified item after a recorded red landing, without
 * rewriting its prior verdict [V2,V6]. The prior commit remains the builder's rework base.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, cause?: string, withdrawVerdict?: boolean }} request
 * @returns {{ id: number, commit: string, supersedes?: number, landingFailure?: object }}
 */
export function reopen(board, id, { agentId, note = '', conflict, cause, reopenFirstRefusalMinutes, quotedLandingFailure, withdrawVerdict, computedConflict, sourceAdvanceReturn, landingFence }) {
  return atomic(board, () => {
    if (sourceAdvanceReturn !== undefined) {
      if (board.executionEngineVersion === undefined) ({ note, conflict, quotedLandingFailure, sourceAdvanceReturn } = board.nativePorts.sealSourceAdvanceReturn(board, id, { agentId, sourceAdvanceReturn, landingFence }));
      const problem = sourceAdvanceReturnProblem(board, getItem(board, id), { agentId, note, conflict, quotedLandingFailure, sourceAdvanceReturn });
      if (problem) throw problem;
    }
    let submittedCommit = null;
    const assertedConflict = conflict;
    conflict = board.nativePorts.conflictValue(computedConflict, conflict);
    const forMerge = conflict !== undefined && conflict !== null;
    let supersedes, landingFailure, withdrawnVerdict;
    const forWithdrawal = withdrawVerdict === true;
    const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
    verdictWithdrawal.checkOptions(withdrawVerdict, forMerge, currentEngine);
    const declaredTransition = MOVES.find((entry) => entry.verb === 'reopen');
    const transition = currentEngine >= 10 ? declaredTransition : { ...declaredTransition, from: ['submitted'] };
    const item = moveItem(board, id, 'reopen', {
      transition,
      checks: {
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        reopenAuthority: (found) => reopenAuthority(board, found, agentId,
          { forWithdrawal, forMerge, currentEngine, computedConflict, assertedConflict }, value => { withdrawnVerdict = value; }, { listAgents, verdictWithdrawalTarget, computedConflictProblem: board.nativePorts.computedConflictProblem }),
        noteGiven: () => (forMerge || note.trim() ? null : new Refused('NOTE_REQUIRED', 'say why the criterion needs correction: --note "why"')),
        causeWellFormed: () => causeProblem(cause),
        notMerged: (found) => found.item_status !== 'verified' || !found.item_merged_commit
          ? null
          : new Refused('ALREADY_MERGED', `item #${id} was merged as ${found.item_merged_commit}; merged items cannot be reopened`),
        landingFailureRecorded: (found) => {
          if (forWithdrawal) { supersedes = withdrawnVerdict.acceptEventId; return null; }
          if (found.item_status !== 'verified' || forMerge) return null;
          const accepted = events(board, { itemId: id }).findLast((event) => {
            if (!['accept', 'merge-only-accept'].includes(event.event_kind)) return false;
            return JSON.parse(event.event_detail).commit === found.item_commit;
          });
          const recorded = landingBatches(board).flatMap((batch) => (batch.culprits ?? []).map((culprit) => ({ batch, culprit })))
            .find(({ culprit }) => culprit.id === id && culprit.commit === found.item_commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')
              && Array.isArray(culprit.tests) && culprit.tests.length
              && culprit.tests.every((failure) => typeof failure.file === 'string' && typeof failure.name === 'string'
                && note.includes(`${failure.file}: ${failure.name}`) && note.includes(culprit.mergeCommit)));
          const quoted = currentEngine >= QUOTED_LANDING_FAILURE_ENGINE;
          const manual = manualLandingFailure(note, { quoted: quoted && (quotedLandingFailure === true || manualLandingFailureQuoted(note)) });
          if (!accepted || (!recorded && !manual)) return new Refused('LANDING_FAILURE_REQUIRED',
            `reopening verified item #${id} needs --note in the format <test file>: <test name>; merge commit <sha>${quoted ? ', or quote a test name containing a semicolon' : ''}`,
            quoted ? board.nativePorts.nextSteps.LANDING_FAILURE_REQUIRED : undefined);
          supersedes = accepted.event_id;
          landingFailure = recorded
            ? { batch: recorded.batch.id, tests: recorded.culprit.tests, mergeCommit: recorded.culprit.mergeCommit }
            : { batch: null, tests: manual.tests, mergeCommit: manual.mergeCommit };
          return null;
        },
        trunkConflicts: null,
        conflictAccepted: (found) => (forMerge ? conflictProblem(board, found, conflict, (accept) => { supersedes = accept; }) : null),
      },
      set: (found) => {
        submittedCommit = found.item_commit;
        return {
          item_verdict: null,
          item_verified_by: null,
          item_owner: null,
          item_lease_until: null,
          item_review_by: null,
          item_review_until: null,
        };
      },
    });
    const returnedAt = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE && reopenFirstRefusalMinutes > 0 && item.item_built_by ? board.clock.now() : undefined;
    const reservation = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalDetail(board, item, reopenFirstRefusalMinutes, returnedAt) : {};
    const returned = forWithdrawal ? { supersedes, withdrawnVerdict } : forMerge ? { supersedes, ...conflictDetail(conflict), ...(computedConflict !== undefined ? { computedConflict } : {}) } : supersedes ? { supersedes, landingFailure } : {};
    const derivedCause = currentEngine >= RIGOR_AUTO_ENGINE
      ? board.nativePorts.deriveRigorCause(board, item, { cause, conflict, landingFailure, agentId }) : cause != null ? { cause } : {};
    const returnedWithCause = currentEngine >= RIGOR_AUTO_ENGINE ? { ...returned, ...derivedCause } : { ...derivedCause, ...returned };
    const trigger = logEvent(board, agentId, 'reopen', id, { ...(sourceAdvanceReturn ? { sourceAdvanceReturn } : {}), commit: submittedCommit, note: note.trim() || conflictNote(conflict), judgment: null, ...reservation,
      ...returnedWithCause }, returnedAt);
    tellFirstRefusal(board, item, reservation, persistShout);
    if (!reservation.reopenFirstRefusal && forMerge && supersedes === undefined && item.item_built_by) persistShout(board, { from: agentId, to: item.item_built_by, text: returnedHeadNotice(id, submittedCommit, conflict) });
    postRigorNotices(board, trigger);
    return { id: item.item_id, commit: submittedCommit, ...returnedWithCause };
  });
}
