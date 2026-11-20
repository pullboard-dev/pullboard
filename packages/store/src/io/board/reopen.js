import { rejectionReturnEnabled } from '../../logic/rework.js';
import { pipelineCause } from "../../../../kernel/index.js";
import { boardWriteSnapshot } from "./write/preparation.js";
import { requireBoardWriteSnapshot } from "./write/preparation.js";
import { verdictWithdrawalTarget } from "../../../../verify/index.js";
import { sourceAdvanceReturnProblem } from "../../logic/advance.js";
import { reopenAuthority } from "../../../../items/index.js";
import { checkOptions } from "../../../../verify/index.js";
import { current } from "./query.js";
import { getItem } from "./query.js";
import { events } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { manualLandingFailure } from "../../../../items/index.js";
import { firstRefusalDetail } from "../../../../items/index.js";
import { tellFirstRefusal } from "../../../../items/index.js";
import { manualLandingFailureQuoted } from "../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { QUOTED_LANDING_FAILURE_ENGINE } from "../../../../state/index.js";
import { REOPEN_FIRST_REFUSAL_ENGINE } from "../../../../state/index.js";
import { IN_STATE } from "../../../../state/index.js";
import { MOVES } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { listAgents } from "./query.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { CONFLICT_ENGINE } from "../../../../state/light.js";
import { SUBMITTED_CONFLICT_ENGINE } from "../../../../state/index.js";
import { causeProblem } from "../../logic/board/rigor.js";
import { conflictDetail } from "../../../../merge/index.js";
import { conflictProblem } from "../../../../merge/index.js";
import { returnedHeadNotice } from "../../../../merge/index.js";
import { conflictNote } from "../../../../kernel/index.js";
import { landingBatches } from "../../../../git/index.js";
import { moveItem } from "../board.js";
import { postRigorNotices } from "../board.js";
import { persistShout } from "./shout.js";
import { endReviewLease } from "./review/lease.js";
import { movesShadowEnabled } from "../../../../config/index.js";
import { movesLiveEnabled } from "../../../../config/index.js";
import { shadowHook } from "./shadow-record.js";
import { reopenDecision } from "./reopen-table.js";
import { reopenDiffers } from "./reopen-table.js";
import { itemPace } from "./sprint-pace.js";

/** The event kinds the item's landing is read from, oldest first, as the pulled writer reads them. */
const LANDING_KINDS = Object.freeze(['merged', 'pull_out', 'pulled', 'published']);

/** The item's landing events as `{ kind, by, detail }`, oldest first; a damaged detail reads as empty. */
function landingHistory(board, id) {
  return board.db.prepare(`SELECT event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${LANDING_KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(id, ...LANDING_KINDS).map(event => { let detail = {}; try { detail = JSON.parse(event.d || '{}'); } catch { detail = {}; } return { kind: event.kind, by: event.by, detail }; });
}

/** Return a submission for correction, or a verified item after a recorded red landing, without
 * rewriting its prior verdict [V2,V6]. The prior commit remains the builder's rework base.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, cause?: string, withdrawVerdict?: boolean }} request
 * @returns {{ id: number, commit: string, supersedes?: number, landingFailure?: object }}
 */
export function reopen(board, id, { agentId, note = '', conflict, cause, reopenFirstRefusalMinutes, quotedLandingFailure, withdrawVerdict, computedConflict, sourceAdvanceReturn, landingFence }) {
  const snapshot = sourceAdvanceReturn !== undefined && board.executionEngineVersion === undefined ? boardWriteSnapshot(board) : null;
  if (snapshot) ({ note, conflict, quotedLandingFailure, sourceAdvanceReturn } = board.nativePorts.sealSourceAdvanceReturn(board, id, { agentId, sourceAdvanceReturn, landingFence }));
  return atomic(board, () => {
    if (snapshot) requireBoardWriteSnapshot(board, snapshot, 'source advance return');
    if (snapshot) board.runtimePorts.sourceAdvanceReceipts.guardLandingWrite(board, landingFence);
    if (sourceAdvanceReturn !== undefined) {
      const problem = sourceAdvanceReturnProblem(board, getItem(board, id), { agentId, note, conflict, quotedLandingFailure, sourceAdvanceReturn });
      if (problem) throw problem;
    }
    if (rejectionReturnEnabled(board) && computedConflict === undefined && sourceAdvanceReturn === undefined && !withdrawVerdict) throw new Refused('BOARD_RETURNS_REJECTED', 'the board returns rejected work');
    let submittedCommit = null;
    const assertedConflict = conflict;
    conflict = board.nativePorts.conflictValue(computedConflict, conflict);
    const forMerge = conflict !== undefined && conflict !== null;
    let supersedes, landingFailure, withdrawnVerdict;
    // With moves.shadow on (or a test's `reopenShadow`), the reopen table decides over the item as it stood before the move, and the compare is recorded [C7,#8388].
    // With moves.live.reopen on (a board's own `movesLive.reopen` stands in for the setting in a store test) the table's answer is applied instead: it refuses what it refuses, and its decided parts are the ones written [C7,#8390].
    const live = (board.movesLive?.reopen ?? movesLiveEnabled('reopen')) === true;
    const hook = live ? null : shadowHook(board, 'reopenShadow', 'reopen', reopenDiffers, movesShadowEnabled);
    const beforeRow = hook || live ? board.db.prepare('SELECT item_status, item_commit, item_merged_commit, item_built_by, item_owner, item_frozen FROM item WHERE item_id = ?').get(id) : null;
    // The table reads the item's frozen pace and its landing history, so sprint's pull-out row can fire; steady reads neither [M2,#9209].
    const pace = beforeRow ? itemPace(beforeRow) : 'steady';
    const history = beforeRow && pace !== 'steady' ? landingHistory(board, id) : [];
    const beforeEvent = hook ? board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id : 0;
    const forWithdrawal = withdrawVerdict === true;
    const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
    checkOptions(withdrawVerdict, forMerge, currentEngine);
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
        conflictAccepted: (found) => (forMerge ? conflictProblem(board, found, conflict, (accept) => { supersedes = accept; }, CONFLICT_ENGINE, ENGINE_VERSION, SUBMITTED_CONFLICT_ENGINE) : null),
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
    endReviewLease(board, id);
    const returnedAt = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE && reopenFirstRefusalMinutes > 0 && item.item_built_by ? board.clock.now() : undefined;
    const returnsToBuilder = (forMerge || landingFailure || forWithdrawal) && currentEngine >= REOPEN_FIRST_REFUSAL_ENGINE;
    const ownReservation = returnsToBuilder ? firstRefusalDetail(board, item, reopenFirstRefusalMinutes, returnedAt) : {};
    const returned = forWithdrawal ? { supersedes, withdrawnVerdict } : forMerge ? { supersedes, ...conflictDetail(conflict), ...(computedConflict !== undefined ? { computedConflict } : {}) } : supersedes ? { supersedes, landingFailure } : {};
    const derivedCause = currentEngine >= RIGOR_AUTO_ENGINE
      ? board.nativePorts.deriveRigorCause(board, item, { cause, conflict, landingFailure, agentId }) : cause != null ? { cause } : {};
    // The table is handed what the board derived (the cause, the conflict's detail, the window a first refusal would open) and decides which of them the event records [C7,#8285].
    const askTable = () => reopenDecision(id, { before: beforeRow, agentId, joined: true, note, cause, conflict, withdrawVerdict: forWithdrawal, supersedes, landingFailure, conflictAccepted: true, withdrawnVerdict, conflictNote: forMerge ? conflictNote(conflict) : '',
      derivedCause, causeOverrides: currentEngine >= RIGOR_AUTO_ENGINE, reservation: ownReservation, conflictDetail: forMerge ? conflictDetail(conflict) : undefined, computedConflict,
      ...(pace !== 'steady' ? { pace, history, redGate: !forMerge && !forWithdrawal && manualLandingFailure(note) ? note.trim() : undefined } : {}) });
    const shadowReopen = () => hook({ id, decided: askTable(),
      wrote: board.db.prepare("SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE event_id>? AND event_kind='reopen' AND item_id=? ORDER BY event_id").all(beforeEvent, id) });
    const liveAnswer = live ? askTable() : null;
    // A refusal rolls the whole move back; a table that throws never takes the move down, so the writer's own event is written [C7,#8390].
    if (liveAnswer?.refused) throw new Refused(liveAnswer.refused.code, liveAnswer.refused.message, liveAnswer.refused.next);
    const decidedEvent = liveAnswer?.events?.find(event => event.kind === 'reopen');
    // Live, every other event the table decides (a sprint pull_out) is written after the reopen, in the table's order [M2,#9209].
    const followingEvents = (liveAnswer?.events ?? []).filter(event => event !== decidedEvent);
    // Live, the reservation and the cause are the table's: the shout and the returned cause follow what it recorded [C7,#8285].
    const reservation = decidedEvent ? (decidedEvent.detail.reopenFirstRefusal ? { reopenFirstRefusal: decidedEvent.detail.reopenFirstRefusal } : {}) : ownReservation;
    const returnedWithCause = currentEngine >= RIGOR_AUTO_ENGINE ? { ...returned, ...derivedCause } : { ...derivedCause, ...returned };
    const trigger = logEvent(board, decidedEvent?.by ?? agentId, 'reopen', id, { ...(sourceAdvanceReturn ? { sourceAdvanceReturn } : {}), commit: submittedCommit, note: note.trim() || conflictNote(conflict), judgment: null, ...reservation,
      ...returnedWithCause, ...(currentEngine >= board.enginePorts.pipelineCauseEngines().pipeline ? { pipelineCause: pipelineCause({ ...derivedCause, conflict, landingFailure, note }) } : {}), ...(decidedEvent ? decidedEvent.detail : {}) }, returnedAt);
    for (const event of followingEvents) logEvent(board, event.by, event.kind, id, event.detail);
    if (hook) shadowReopen();
    tellFirstRefusal(board, item, reservation, persistShout);
    if (!reservation.reopenFirstRefusal && forMerge && supersedes === undefined && item.item_built_by) persistShout(board, { from: agentId, to: item.item_built_by, text: returnedHeadNotice(id, submittedCommit, conflict) });
    postRigorNotices(board, trigger);
    return { id: item.item_id, commit: submittedCommit, ...returnedWithCause };
  });
}
