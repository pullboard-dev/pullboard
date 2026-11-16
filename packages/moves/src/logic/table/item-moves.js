/** The item-move half of the backbone table: every declared guard as a rule fact, and the rows that run them over a recorded move [C7,#8100]. */
import { MACHINE } from '../../../../state/light.js';
import { leaseLive } from '../lifecycle/rules.js';
import { unmetWaits } from '../lifecycle/rules.js';

/**
 * The board event kind each declared move is recorded under, where it differs from its verb or has no verb of its own.
 * Why: the board writes `claim`, `accept`, `verify`; the machine declares verbs, so one map joins them and nothing else does.
 */
const KIND_VERB = Object.freeze({ verify: 'accept', 'merge-only-accept': 'accept', 'outside-intake': 'intake' });

/** Event kinds that carry no declared item move but are recorded as accepted bookkeeping: the board wrote them, so the table accepts them. */
const BOOKKEEPING = Object.freeze(['add', 'renew', 'merged', 'hold_item', 'unhold_item', 'edit', 'lapse']);

/** The machine verb a recorded move name stands for, or undefined. */
const verbOf = (name) => KIND_VERB[name] ?? (MACHINE.moves.some(move => move.verb === name) ? name : undefined);

/** True when the move is one the table knows: a declared verb or accepted bookkeeping. */
export const knownMove = (move) => verbOf(move?.name) !== undefined || BOOKKEEPING.includes(move?.name);

/** The declared row a move runs: the verb's row whose `from` holds the item's state, else the verb's first row. */
export function rowOf(snapshot, move) {
  const rows = MACHINE.moves.filter(entry => entry.verb === verbOf(move?.name));
  return rows.find(row => row.from.includes(snapshot.item?.status)) ?? rows[0];
}

/** Does the machine declare this guard for the row this move runs? */
const declares = (snapshot, move, guard) => (rowOf(snapshot, move)?.guards ?? []).includes(guard);

/** A maintenance sweep, which any seat may write for a dead claim, is marked in the move's detail. */
const maintenance = (move) => Boolean(move.detail?.maintenance);

/**
 * The guards the board can judge from its own history, over `{ item, items }` and a move `{ name, actor, at, detail }`.
 * Each reuses the lifecycle rules' helpers (#8059) so readiness and leases are defined once. Every other declared guard
 * is a fact about the CLI's view of git or the worktree, which the board never recorded: it holds unless the snapshot's `facts` says it did not.
 */
const FROM_BOARD = {
  itemExists: (s) => s.item?.created !== false,
  inState: (s, m) => rowOf(s, m) === undefined || rowOf(s, m).from.includes(s.item?.status),
  coordinatorOnly: (s, m) => m.actor === 'coordinator',
  isHolder: (s, m) => s.item?.owner === m.actor,
  holderOrCoordinator: (s, m) => m.actor === 'coordinator' || s.item?.owner === m.actor || maintenance(m),
  releaseOwnsWork: (s, m) => m.actor === 'coordinator' || s.item?.owner === m.actor || maintenance(m),
  notBuilder: (s, m) => !(s.item?.builder && s.item.builder === m.actor),
  notMerged: (s) => !s.item?.merged,
  // A spec refreeze reopens verified work only while it is unmerged (store refreeze.js); the CLI may still say it does not hold.
  specRefreezeAllowed: (s) => s.facts?.specRefreezeAllowed !== false && !(s.item?.status === 'verified' && s.item.merged),
  itemNotHeld: (s) => !s.item?.held,
  notHeldByAnother: (s, m) => !(s.item?.status === 'claimed' && s.item.owner !== m.actor && leaseLive(s.item, m.at)),
  dependenciesVerified: (s) => !s.items || !unmetWaits(s.item, s.items).length,
};

/** One rule definition per declared guard, said in the machine's own words. */
export const GUARD_RULES = Object.fromEntries(MACHINE.guards.map(guard => [guard.id, {
  says: guard.rule || `the ${guard.id} guard holds`,
  holds: FROM_BOARD[guard.id] ?? ((s) => s.facts?.[guard.id] !== false),
}]));

/** The name of the fact that says a guard holds for moves that declare it, and is true for every other move. */
export const appliedFact = (guard) => `applied.${guard}`;

/** One rule per guard: the move does not declare it, or it holds. Why: one flat guard list can then serve every verb. */
export const APPLIED_RULES = Object.fromEntries(MACHINE.guards.map(guard => [appliedFact(guard.id), {
  says: `the move does not declare ${guard.id}, or ${GUARD_RULES[guard.id].says}`,
  reads: [guard.id],
  holds: (s, m, fact) => !declares(s, m, guard.id) || fact(guard.id),
}]));

/** The one fact about the move itself: the table knows it. */
export const KNOWN_RULES = {
  knownMove: { says: 'the move is a declared item move or accepted bookkeeping', holds: (s, m) => knownMove(m) },
};

/** The flat guard rows, in the order the machine first declares each guard, ending with the move being known. */
export const ITEM_GUARDS = Object.freeze([
  { id: 'known', requires: 'knownMove', code: 'UNKNOWN_MOVE', message: (s, m) => `the backbone has no move ${m.name}`, next: 'use a move the machine declares: pullboard explain backbone' },
  ...[...new Set(MACHINE.moves.flatMap(move => move.guards ?? []))].map(id => {
    const guard = MACHINE.guards.find(entry => entry.id === id);
    return { id, requires: appliedFact(id), code: guard?.refuse || 'WRONG_STATE', message: guard?.rule ?? id, next: guard?.next ?? 'see the move' };
  }),
]);

/** The one outcome every accepted move has: the board writes the move's kind, its actor and the detail the caller supplied. */
export const ITEM_OUTCOMES = Object.freeze([
  { id: 'record', patch: (s, m) => { const to = rowOf(s, m)?.to; return to ? { status: to } : {}; }, events: (s, m) => [{ kind: m.name, by: m.actor, detail: m.detail ?? {} }] },
]);
