/** The one pure engine every move table runs through: guards name facts from the rules layer, a gap is a refusal [C7,#8064]. */
import { deriveFact } from './rules.js';

/**
 * @typedef {object} MoveTable
 * @property {string} name - The table's name, quoted when it has a gap.
 * @property {{ id: string, requires: string, code: string, codeOf?: Function, message: string | Function, next: string | Function }[]} guards - Tried in order; the first whose required fact fails refuses.
 * @property {{ id: string, when?: string, patch: Function, events: Function }[]} outcomes - The first whose `when` fact holds (or that has none) wins.
 * @property {{ id: string, when: string, apply: Function }[]} [followups] - Each sees the item before and after the move so far.
 */

/**
 * Run a move table against a snapshot and a move, using only facts the rules layer defines.
 * Guards are tried in order and the first failing one refuses, as today's first throw wins (a guard whose code the shell decides names it with `codeOf`); with none refusing,
 * the first matching outcome gives the patch and events, then each follow-up fact is read over the item as it stands after the events so far.
 * Why: a rule lives in one row and one named fact, so the refusal, its trace and its words never drift apart.
 *
 * @param {MoveTable} table
 * @param {Readonly<Record<string, object>>} rules - From defineRules.
 * @param {object} snapshot - Everything the move may read; frozen by the rules layer.
 * @param {{ name?: string }} move - The caller's request.
 * @returns {{ refused: { code: string, message: string, next: string, row: string | null, fact: string | null, trace: { fact: string, holds: boolean }[] } } | { patch: object, events: object[], via: string[] }}
 */
export function runTable(table, rules, snapshot, move) {
  for (const guard of table.guards) {
    const answer = deriveFact(rules, guard.requires, snapshot, move);
    if (!answer.holds) {
      return { refused: { code: guard.codeOf ? guard.codeOf(snapshot, move) : guard.code, message: text(guard.message, snapshot, move), next: text(guard.next, snapshot, move), row: guard.id, fact: guard.requires, trace: answer.trace } };
    }
  }
  const outcome = table.outcomes.find(entry => entry.when === undefined || deriveFact(rules, entry.when, snapshot, move).holds);
  if (!outcome) {
    const name = move?.name ?? 'the move';
    return { refused: { code: 'TABLE_GAP', message: `table ${table.name} has no outcome for move ${name}`, next: `add an outcome row to table ${table.name} for the state this move met, or a guard that refuses it`, row: null, fact: null, trace: [] } };
  }
  let result = { patch: { ...outcome.patch(snapshot, move) }, events: [...outcome.events(snapshot, move)], via: [outcome.id] };
  for (const rule of table.followups ?? []) {
    const view = { before: snapshot, after: settle(snapshot, result), move, via: result.via };
    if (!deriveFact(rules, rule.when, { ...view.after, before: snapshot }, move).holds) continue;
    const extra = rule.apply(view);
    result = { patch: { ...result.patch, ...extra.patch }, events: [...result.events, ...(extra.events ?? [])], via: [...result.via, rule.id] };
  }
  return result;
}

/** The snapshot a follow-up sees: the item patched, and the new events appended to its history when it has one. */
function settle(snapshot, { patch, events }) {
  const history = snapshot.history ?? [];
  return { ...snapshot, item: snapshot.item && { ...snapshot.item, ...patch }, history: [...history, ...events] };
}

/** A row's text may be a string or a function of the snapshot and move. */
function text(value, snapshot, move) {
  return typeof value === 'function' ? value(snapshot, move) : value;
}
