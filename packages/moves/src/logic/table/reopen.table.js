/** The reopen move as one pure table: every rule the board enforces when a submission, or a verified item after a red landing, goes back to its builder [C7,#8258]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';

/**
 * The next step the reopen command prints for each refusal code; the live command's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const REOPEN_NEXT = Object.freeze({
  BOARD_RETURNS_REJECTED: 'run pullboard next to resume returned work',
  BAD_VERDICT_WITHDRAW: 'use --withdraw-verdict with a note, or report a conflict separately',
  VERDICT_WITHDRAW_FORBIDDEN: 'ask the accepting reviewer or coordinator to withdraw this verdict',
  VERDICT_WITHDRAW_STATE: 'refresh the item; withdraw only a current acceptance before landing',
  REVIEW_HELD: 'take another review: pullboard next --verify',
  ALREADY_MERGED: 'file the follow-up as a new item: pullboard add <lane> "<title>"',
  BAD_CAUSE: 'name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out',
  BAD_CONFIG: 'fix pullboard.json as the message says, then commit it: git commit -m "chore: fix pullboard config" pullboard.json',
  BAD_CONFLICT: 'run pullboard reopen <id> --conflict <file> [--conflict <file>] from the main checkout',
  CONFLICT_FILES: 'name only the files Git reports as conflicting with the trunk: pullboard reopen <id> --conflict <file> [--conflict <file>]',
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
  LANDING_FAILURE_REQUIRED: 'reopen with --note "<test file>: <test name>; merge commit <sha>", or with --note \'<test file>: "<test name; with semicolon>"; merge commit <sha>\' when the test name contains a semicolon, or use --conflict <file> for each file that only conflicts with the trunk',
  MERGE_CHECK_FAILED: 'use Git 2.38 or newer (git --version), then retry',
  NOTE_REQUIRED: 'add --note "<what happened>"',
  NOT_ACCEPTED: 'reopen a submission with --note "why"; --conflict is for accepted work',
  NOT_CONFLICTING: 'merge it; reopen only after a red landing, with --note "<test file>: <test name>; merge commit <sha>"',
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NOT_SUBMITTED: 'see its state with pullboard show <id>; verify only submitted items: pullboard next --verify',
  NO_ITEM: 'find the item id: pullboard list --all',
  NO_TRUNK: 'in the main checkout, switch to the repository’s trunk branch and run pullboard inbox',
  SESSION_LEDGER: 'make the agent-session ledger named in the message writable by this user, then run the command again',
});

/** The note the event records: the caller's, else the one a reported conflict states. */
const noteOf = (m) => (typeof m.note === 'string' ? m.note.trim() : '') || m.conflictNote;
const blank = (text) => !(typeof text === 'string' && text.trim());

/**
 * Build the reopen rules and table over the board's own cause check, handed in by the caller.
 * Why: moves may not reach into the store, and the cause forms must stay one source; the caller passes the store's `causeProblem`.
 * Snapshot: `{ actor: { id, joined }, item: { id, status, commit, mergedCommit } | null, landing: { accepted, failure }, conflict: { accepted }, withdrawal: { acceptEventId } }`,
 * where the last three are what git, the landing batches and the verdict lookup answered before the move ran.
 * Move: `{ id, actor, note, cause, conflict, conflictNote, withdrawVerdict }`. The derived cause, first-refusal reservation, shouts and the lease end stay with the shell.
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
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, supersedes: s.withdrawal.acceptEventId } }] },
      { id: 'return-conflict', when: 'supersedesConflict', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, ...(s.conflict.supersedes === undefined ? {} : { supersedes: s.conflict.supersedes }), conflict: m.conflict } }] },
      { id: 'return-landing-failure', when: 'landingFailureReturn', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null, supersedes: s.landing.accepted, landingFailure: s.landing.failure } }] },
      { id: 'return-submission', patch: () => ({ status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null }),
        events: (s, m) => [{ kind: 'reopen', by: m.actor, detail: { commit: s.item.commit, note: noteOf(m), judgment: null } }] },
    ]),
  });
  return Object.freeze({ rules, table });
}
