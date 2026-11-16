/** The landing-pulled table: a recorded revert ends an item's pull-out, so its landing goes from pulling back to none [M2,R3,#8870]. */
import { defineRules } from './rules.js';
import { landingOf } from './rules.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The rules over a snapshot `{ item: { id, status, mergedCommit }, history }` and a move `{ id, actor, revert }`, where `revert` is the
 * commit on main that undid the item's landed commit. Why a table of its own: the lander doing the revert is io, and this row is the
 * one place that says what its receipt records.
 */
export const PULLED_RULES = defineRules({
  coordinatorActs: { says: 'the coordinator records the revert', holds: (s, m) => m.actor === 'coordinator' },
  itemExists: { says: 'the item exists', holds: (s) => Boolean(s.item) },
  pulling: { says: "the item's landing is pulling", holds: (s) => landingOf(s.item, s.history) === 'pulling' },
  revertNamed: { says: 'the move names the revert commit', holds: (s, m) => SHA.test(String(m.revert ?? '')) },
});

/** The landing-pulled table: guards in order, then the one outcome that writes pulled with the revert commit. */
export const PULLED_TABLE = Object.freeze({
  name: 'landing-pulled',
  guards: Object.freeze([
    { id: 'coordinator', requires: 'coordinatorActs', code: 'COORDINATOR_ONLY', message: 'only the coordinator records a pull-out revert', next: 'let the lander record the revert' },
    { id: 'item-exists', requires: 'itemExists', code: 'NO_ITEM', message: (s, m) => `no item #${m.id}; see: pullboard list`, next: 'pullboard list' },
    { id: 'pulling', requires: 'pulling', code: 'NOT_PULLING', message: (s, m) => `item #${m.id} has no pull-out in progress`, next: 'pullboard show <id>' },
    { id: 'revert-named', requires: 'revertNamed', code: 'REVERT_COMMIT', message: 'a pulled record names the full revert commit on main', next: 'pass the revert commit the lander pushed' },
  ]),
  outcomes: Object.freeze([
    { id: 'pulled', patch: () => ({}), events: (s, m) => [{ kind: 'pulled', by: m.actor, detail: { commit: m.revert, ...(s.item.mergedCommit ? { reverted: s.item.mergedCommit } : {}) } }] },
  ]),
});

/** The table and its rules, as the engine the board root hands the store's pulled writer [M2,R3,#9098]. */
export function pulledEngine() {
  return { table: PULLED_TABLE, rules: PULLED_RULES };
}
