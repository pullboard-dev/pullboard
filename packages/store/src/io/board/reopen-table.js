/** The reopen move table run beside the store's reopen writer, so its answer is compared with the events the writer wrote [C7,#8388]. */
import { runReopenTable } from '../../logic/board/landing/lease.js';
import { firstDifference } from './shadow-record.js';

/** The detail keys the reopen table decides: the cause, the conflict and the first-refusal reservation as well as the commit, note and links; the pipeline cause belongs to the writer's shell. */
const DECIDED = Object.freeze(['commit', 'note', 'judgment', 'supersedes', 'landingFailure', 'conflict', 'cause', 'computedConflict', 'reopenFirstRefusal']);

/** A reopen event reduced to what the table decides, as plain JSON so an absent key and an undefined one read alike. */
function decidedEvent({ kind, by, detail }) {
  const whole = JSON.parse(JSON.stringify(typeof detail === 'string' ? JSON.parse(detail) : detail ?? {}));
  return { kind, by, detail: Object.fromEntries(DECIDED.filter(key => whole[key] !== undefined).map(key => [key, whole[key]])) };
}

/**
 * The reopen table's answer for a reopen the writer has just worked out, over the item row as it stood before the move.
 * Why the writer's derived facts go in: what git, the landing batches and the verdict lookup answered are the table's inputs (its replay takes them from history the same way); the table decides the rest.
 *
 * `actor.granted` is the writer's own authority answer for a reported conflict: reopenAuthority has already accepted the seat (a computed conflict the board checked, or a listed agent on the older engine) before the table is asked.
 * `pace`, `history` and `redGate` come only for a non-steady item: its frozen pace, its landing events and the red gate note a landed sprint submission is returned with [M2,#9209].
 * @param {{ before: object | undefined, agentId: string, joined: boolean, note: string, pace?: string, history?: object[], redGate?: string, cause?: unknown, conflict?: { files: string[], trunk: string } | null, withdrawVerdict: boolean, supersedes?: number, landingFailure?: object, conflictAccepted: boolean, withdrawnVerdict?: { acceptEventId?: number } | null, conflictNote: string, derivedCause?: object, causeOverrides?: boolean, reservation?: object, conflictDetail?: object, computedConflict?: unknown }} call
 * @param {number} id
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[] } | { threw: string }}
 */
export function reopenDecision(id, call) {
  const { before, agentId, joined, note, cause, conflict, withdrawVerdict, supersedes, landingFailure, conflictAccepted, withdrawnVerdict, derivedCause, causeOverrides, reservation, conflictDetail, computedConflict, pace, history, redGate } = call;
  const forMerge = conflict !== undefined && conflict !== null;
  const snapshot = { actor: { id: agentId, joined, ...(forMerge ? { granted: true } : {}) },
    item: before ? { id, status: before.item_status, commit: before.item_commit, mergedCommit: before.item_merged_commit ?? null,
      ...(pace ? { builtBy: before.item_built_by ?? null, owner: before.item_owner ?? null } : {}) } : null,
    landing: landingFailure ? { accepted: supersedes, failure: landingFailure } : redGate ? { accepted: undefined, failure: redGate } : {},
    ...(pace ? { pace, history: history ?? [] } : {}),
    conflict: forMerge ? { accepted: conflictAccepted, supersedes, detail: conflictDetail, computed: computedConflict } : {},
    cause: { derived: derivedCause ?? {}, overrides: causeOverrides !== false },
    reservation: reservation ?? {},
    ...(withdrawnVerdict ? { withdrawal: { acceptEventId: withdrawnVerdict.acceptEventId } } : {}) };
  const move = { id, actor: agentId, note, cause, ...(forMerge ? { conflict, conflictNote: call.conflictNote } : {}), ...(withdrawVerdict ? { withdrawVerdict: true } : {}) };
  try { return runReopenTable(snapshot, move); } catch (error) { return { threw: error?.code ?? String(error?.message ?? error) }; }
}

/**
 * Where the reopen table's answer and the writer's reopen event part: `refused` when the table refused a reopen the writer made,
 * else the first differing path between the decided parts of the two events, or null when they agree.
 */
export function reopenDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused) return 'refused';
  return firstDifference((decided?.events ?? []).map(decidedEvent), wrote.map(decidedEvent), 'events');
}
