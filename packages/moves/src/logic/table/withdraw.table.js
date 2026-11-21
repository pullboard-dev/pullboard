/** The withdraw move as one pure table: every rule the board enforces when the coordinator closes an item nobody should build [C7,#8258]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { WITHDRAW_NEXT } from './next.js';
export { WITHDRAW_NEXT } from './next.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const blank = (text) => !(typeof text === 'string' && text.trim());

/** The system actor's id: the one the board already records its own writes under, so no new `by` value enters the state machine. */
const SYSTEM_ACTOR = 'sentinel';

/** A withdraw as met by the system: the sentinel actor, a sentinel cause key and a cited main commit, at an engine that has the path (an unstamped snapshot reads as current). */
function systemAsMet(s, m, metEngine) {
  return Number.isInteger(metEngine) && m.actor === SYSTEM_ACTOR
    && typeof m.cause === 'string' && m.cause.startsWith('sentinel:')
    && typeof m.metCommit === 'string' && /^[a-f0-9]{40,64}$/u.test(m.metCommit)
    && (s.engine === undefined || (Number.isInteger(s.engine) && s.engine >= metEngine));
}

/** Does the item still match the open frozen Main red an audit observed (the audit's `expected`)? */
function mainRedMatches(item, expected) {
  let frozen;
  try { frozen = JSON.parse(item.frozen ?? 'null'); } catch { frozen = null; }
  return expected.status === 'open' && typeof expected.title === 'string' && expected.title.startsWith('Main red:')
    && typeof expected.check === 'string' && /^[a-f0-9]{64}$/u.test(expected.frozenDigest ?? '')
    && typeof expected.head === 'string' && /^[a-f0-9]{40,64}$/u.test(expected.head)
    && item.status === expected.status && item.title === expected.title
    && item.check === expected.check && item.frozenDigest === expected.frozenDigest
    && sha256(item.frozen ?? '') === expected.frozenDigest
    && frozen?.title === expected.title && frozen?.check === expected.check;
}

/** The one replay-stable id the required cause fact carries, as the board derives it. */
function mainRedFactId(id, expected) {
  const hash = sha256(JSON.stringify(['main-red-fixed', id, expected.frozenDigest, expected.head]));
  return [hash.slice(0, 8), hash.slice(8, 12), `5${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join('-');
}

/**
 * Build the withdraw rules and table over the states the lifecycle machine lets a withdrawal start from, handed in by the caller.
 * Why: moves may not reach into the state package, and the starting states must stay one source (the machine's withdraw move);
 * the caller passes its `from` list, so there is no second copy to drift.
 * Snapshot: `{ actor: { id, joined }, item: { id, status, title, check, frozen, frozenDigest } | null }`.
 * Move: `{ id, actor, reason, expected, cause, metCommit }`; `cause` and `metCommit` (a main commit) only let the system actor withdraw as met, at `board.metEngine`. Closing the item's asks and ending its hand-off and review lease stay with the shell.
 *
 * @param {{ from: readonly string[], metEngine?: number }} board
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function withdrawEngine(board) {
  if (!Array.isArray(board?.from) || !board.from.length) {
    throw new Refused('WITHDRAW_TABLE_INPUTS', 'the withdraw table needs the states a withdrawal may start from', "pass the withdraw move's `from` list from the state package's front door");
  }
  const rules = defineRules({
    joined: { says: 'the caller is a joined seat', holds: (s) => s.actor?.joined !== false },
    coordinator: { says: 'the caller is the coordinator, or the system actor withdrawing as met with a cause and a cited main commit', holds: (s, m) => m.actor === 'coordinator' || systemAsMet(s, m, board.metEngine) },
    reasonGiven: { says: 'the withdrawal says why', holds: (s, m) => !blank(m.reason) },
    itemExists: { says: 'the item exists', holds: (s) => Boolean(s.item) },
    mainRedUnchanged: { says: 'an audit-bound withdrawal still matches the Main red it observed', holds: (s, m) => m.expected === undefined || m.expected === null || mainRedMatches(s.item, m.expected) },
    withdrawable: { says: 'the item is open, claimed, submitted or verified', holds: (s) => board.from.includes(s.item?.status) },
    auditBound: { says: 'the withdrawal carries a Main red audit', holds: (s, m) => Boolean(m.expected) },
  });
  const table = Object.freeze({
    name: 'withdraw',
    guards: Object.freeze([
      { id: 'joined', requires: 'joined', code: 'NOT_JOINED', message: 'this worktree has not joined a lane; run pullboard join <lane> --model "<model name>"', next: WITHDRAW_NEXT.NOT_JOINED },
      { id: 'coordinator-only', requires: 'coordinator', code: 'COORDINATOR_ONLY', message: 'only the coordinator withdraws items', next: WITHDRAW_NEXT.COORDINATOR_ONLY },
      { id: 'note-given', requires: 'reasonGiven', code: 'NOTE_REQUIRED', message: 'say why it is withdrawn', next: WITHDRAW_NEXT.NOTE_REQUIRED },
      { id: 'item-exists', requires: 'itemExists', code: 'NO_ITEM', message: (s, m) => `no item #${m.id}; see: pullboard list`, next: WITHDRAW_NEXT.NO_ITEM },
      { id: 'main-red-unchanged', requires: 'mainRedUnchanged', code: 'STALE_MAIN_RED', message: (s, m) => `item #${m.id} changed after its Main red audit`, next: WITHDRAW_NEXT.STALE_MAIN_RED },
      { id: 'in-state', requires: 'withdrawable', code: 'CLOSED', message: (s, m) => `item #${m.id} is ${s.item.status}`, next: WITHDRAW_NEXT.CLOSED },
    ]),
    outcomes: Object.freeze([
      { id: 'withdraw', patch: (s, m) => ({ status: 'withdrawn', withdrawnReason: m.reason.trim(), owner: null, leaseUntil: null }),
        events: (s, m) => [{ kind: 'withdraw', by: m.actor, detail: { reason: m.reason.trim() } }] },
    ]),
    followups: Object.freeze([
      { id: 'main-red-fix', when: 'auditBound',
        apply: ({ move: m }) => ({ patch: {}, events: [{ kind: 'fact', by: m.actor, detail: { id: mainRedFactId(m.id, m.expected), kind: 'measurement', ref: null, supersedes: null,
          text: `Fixed on main by ${m.expected.head}; every file named in the frozen check passed in the current-tip audit.` } }] }) },
    ]),
  });
  return Object.freeze({ rules, table });
}
