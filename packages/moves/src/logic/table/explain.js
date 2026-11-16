/** A move table explains itself in order from the same rule words its guards run, and its states are checked for gaps [C7,#8065]. */
import { Refused } from '../../../../kernel/light.js';
import { rowApplies } from './run.js';

/**
 * List every guard in order with its id, code, the required fact's words and the next step, then the outcomes and follow-ups.
 * Why: explain reads the rule's `says` the guard itself requires, so the docs and the refusal cannot drift apart.
 * Given a pace, rows whose `paces` exclude it are left out, as runTable skips them; a row's `paces` and `always` are listed when it has them.
 *
 * @param {import('./run.js').MoveTable} table
 * @param {Readonly<Record<string, { says: string }>>} rules - From defineRules.
 * @param {{ pace?: string }} [options] - With no pace, every row is listed.
 * @returns {{ table: string, guards: object[], outcomes: object[], followups: object[] }}
 */
export function explainTable(table, rules, { pace } = {}) {
  const words = (fact) => {
    if (!Object.hasOwn(rules, fact)) throw new Refused('RULE_UNDEFINED', `table ${table.name} names fact ${fact}, which no rule defines`, `define ${fact} in the rules, or name a defined fact in the table`);
    return rules[fact].says;
  };
  const next = (value) => (typeof value === 'string' ? value : '(depends on the item)');
  const rows = (list) => (pace === undefined ? list : list.filter(row => rowApplies(row, pace)));
  const tags = (row) => ({ ...(row.paces ? { paces: [...row.paces] } : {}), ...(row.always ? { always: row.always } : {}) });
  return {
    table: table.name,
    guards: rows(table.guards).map((guard, index) => ({ order: index + 1, id: guard.id, code: guard.code, fact: guard.requires, says: words(guard.requires), next: next(guard.next), ...tags(guard) })),
    outcomes: rows(table.outcomes).map(outcome => ({ id: outcome.id, fact: outcome.when ?? null, says: outcome.when === undefined ? 'otherwise' : words(outcome.when), ...tags(outcome) })),
    followups: rows(table.followups ?? []).map(rule => ({ id: rule.id, fact: rule.when, says: words(rule.when), ...tags(rule) })),
  };
}

/**
 * Name every stored state the table neither starts from nor explicitly refuses.
 * A table declares `states: { start: [...], refused: [...] }`; a guard may also list `refusesStates`.
 * Why: a state with no row is how a zombie gate ships, so the gap fails here, before any move meets it.
 *
 * @param {{ states?: { start?: string[], refused?: string[] }, guards?: { refusesStates?: string[] }[] }} table
 * @param {string[]} states - Every state the board can store.
 * @returns {{ gaps: string[], start: string[], refused: string[] }}
 */
export function tableCoverage(table, states) {
  const start = [...(table.states?.start ?? [])];
  const refused = [...new Set([...(table.states?.refused ?? []), ...(table.guards ?? []).flatMap(guard => guard.refusesStates ?? [])])];
  const covered = new Set([...start, ...refused]);
  return { gaps: states.filter(state => !covered.has(state)), start, refused };
}
