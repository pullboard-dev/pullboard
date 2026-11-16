/** The reopen move as one pure table: every rule the board enforces when a submission, or a verified item after a red landing, goes back to its builder [C7,#8258]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { REOPEN_NEXT } from './next.js';
export { REOPEN_NEXT } from './next.js';

/** The note the event records: the caller's, else the one a reported conflict states. */
const noteOf = (m) => (typeof m.note === 'string' ? m.note.trim() : '') || m.conflictNote;
/** The cause fields a return records: the derived rigor cause, ordered against `returned` (a conflict's own cause) as the board's engine orders them. */
const withCause = (s, returned) => (s.cause?.overrides === false ? { ...(s.cause?.derived ?? {}), ...returned } : { ...returned, ...(s.cause?.derived ?? {}) });
/** The first-refusal window, recorded only on the returns that hand the item back to its builder. */
const windowOf = (s) => s.reservation ?? {};
const blank = (text) => !(typeof text === 'string' && text.trim());

/**
 * Build the reopen rules and table over the board's own cause check, handed in by the caller.
 * Why: moves may not reach into the store, and the cause forms must stay one source; the caller passes the store's `causeProblem`.
 * Snapshot: `{ actor: { id, joined }, item: { id, status, commit, mergedCommit } | null, landing: { accepted, failure }, conflict: { accepted, supersedes, detail, computed }, withdrawal: { acceptEventId },
 * cause: { derived, overrides }, reservation }`, where landing, conflict and withdrawal are what git, the landing batches and the verdict lookup answered before the move ran,
 * `cause.derived` is the board's derived rigor cause (`overrides`: it wins over the conflict's own cause), and `reservation` is the first-refusal window the board offers.
 * The table decides which of them each outcome records: the cause on every return, the conflict detail on a conflict return, the reservation on a conflict, landing-failure or verdict-withdrawal return only.
 * Move: `{ id, actor, note, cause, conflict, conflictNote, withdrawVerdict }`. Shouts and the lease end stay with the shell.
 *
 * @param {{ causeProblem: (cause: unknown) => { message: string } | null, states: readonly string[] }} board
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function reopenEngine(board) {
  if (typeof board?.causeProblem !== 'function' || !Array.isArray(board?.states) || !board.states.length) {
    throw new Refused('REOPEN_TABLE_INPUTS', 'the reopen table needs the cause check and the states a reopen may start from', "pass the store's causeProblem and the reopen move's `from` list");
  }
  const forMerge = (m) => m.conflict !== undefined && m.conflict !== null;
  const rules = defineRules({
    joined: { says: 'the caller is a joined seat', holds: (s) => s.actor?.joined !== false },
    itemExists: { says: 'the item exists', holds: (s) => Boolean(s.item) },
    reopenable: { says: 'the item is submitted or verified', holds: (s) => board.states.includes(s.item?.status) },
    authorised: { says: 'the coordinator reopens, or a verdict withdrawal is left to its reviewer', holds: (s, m) => m.actor === 'coordinator' || (m.withdrawVerdict === true && Boolean(s.withdrawal)) },
    noteGiven: { says: 'the reopen says why, unless it reports a merge conflict', holds: (s, m) => forMerge(m) || !blank(m.note) },
    causeWellFormed: { says: 'a named cause has a form the board knows', holds: (s, m) => board.causeProblem(m.cause) === null },
    notMerged: { says: 'the item was not merged', holds: (s) => !(s.item.status === 'verified' && s.item.mergedCommit) },
    withdrawing: { says: 'the reopen withdraws a verdict', holds: (s, m) => m.withdrawVerdict === true },
    landingFailureRecorded: { says: 'a verified item reopens only after a recorded red landing',
      holds: (s, m) => m.withdrawVerdict === true || s.item.status !== 'verified' || forMerge(m) || Boolean(s.landing?.accepted !== undefined && s.landing?.failure) },
    supersedesConflict: { says: 'the reopen reports a merge conflict', holds: (s, m) => forMerge(m) },
    landingFailureReturn: { says: 'the reopen returns a verified item after a red landing', holds: (s) => s.item.status === 'verified' && Boolean(s.landing?.failure) },
    conflictAccepted: { says: 'a reported conflict is one git confirmed', holds: (s, m) => !forMerge(m) || s.conflict?.accepted !== false },
  });
  const table = Object.freeze({
    name: 'reopen',
    guards: Object.freeze([
      { id: 'joined', requires: 'joined', code: 'NOT_JOINED', message: 'this worktree has not joined a lane; run pullboard join <lane> --model "<model name>"', next: REOPEN_NEXT.NOT_JOINED },
      { id: 'item-exists', requires: 'itemExists', code: 'NO_ITEM', message: (s, m) => `no item #${m.id}; see: pullboard list`, next: REOPEN_NEXT.NO_ITEM },
      { id: 'in-state', requires: 'reopenable', code: 'NOT_SUBMITTED', message: (s, m) => `item #${m.id} is ${s.item.status}, not submitted`, next: REOPEN_NEXT.NOT_SUBMITTED },
      { id: 'authority', requires: 'authorised', code: 'COORDINATOR_ONLY', message: 'only the coordinator reopens submissions', next: REOPEN_NEXT.COORDINATOR_ONLY },
      { id: 'note-given', requires: 'noteGiven', code: 'NOTE_REQUIRED', message: 'say why the criterion needs correction: --note "why"', next: REOPEN_NEXT.NOTE_REQUIRED },
      { id: 'cause-well-formed', requires: 'causeWellFormed', code: 'BAD_CAUSE', message: (s, m) => board.causeProblem(m.cause)?.message ?? '', next: REOPEN_NEXT.BAD_CAUSE },
      { id: 'not-merged', requires: 'notMerged', code: 'ALREADY_MERGED', message: (s, m) => `item #${m.id} was merged as ${s.item.mergedCommit}; merged items cannot be reopened`, next: REOPEN_NEXT.ALREADY_MERGED },
      { id: 'landing-failure', requires: 'landingFailureRecorded', code: 'LANDING_FAILURE_REQUIRED',
        message: (s, m) => `reopening verified item #${m.id} needs --note in the format <test file>: <test name>; merge commit <sha>`, next: REOPEN_NEXT.LANDING_FAILURE_REQUIRED },
      { id: 'conflict-accepted', requires: 'conflictAccepted', code: 'CONFLICT_FILES', message: 'name only the files Git reports as conflicting with the trunk', next: REOPEN_NEXT.CONFLICT_FILES },
    ]),
    outcomes: Object.freeze([
      { id: 'withdraw-verdict', when: 'withdrawing', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, ...windowOf(s), ...withCause(s, { supersedes: s.withdrawal.acceptEventId }) } }] },
      { id: 'return-conflict', when: 'supersedesConflict', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, ...windowOf(s), ...withCause(s, { ...(s.conflict.supersedes === undefined ? {} : { supersedes: s.conflict.supersedes }), ...(s.conflict.detail ?? { conflict: m.conflict }), ...(s.conflict.computed === undefined ? {} : { computedConflict: s.conflict.computed }) }) } }] },
      { id: 'return-landing-failure', when: 'landingFailureReturn', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, ...windowOf(s), ...withCause(s, { supersedes: s.landing.accepted, landingFailure: s.landing.failure }) } }] },
      { id: 'return-submission', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, ...withCause(s, {}) } }] },
    ]),
  });
  return Object.freeze({ rules, table });
}
