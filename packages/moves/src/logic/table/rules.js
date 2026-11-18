/** The one derived-facts layer every move table reads by name: rules over a frozen snapshot, each answer traced to the facts it read [C7]. */
import { Refused } from '../../../../kernel/light.js';

/**
 * @typedef {object} RuleDefinition
 * @property {string} says - What the fact means, in words; explain and refusals read it.
 * @property {string[]} [reads] - The other facts this rule derives from, by name.
 * @property {(snapshot: object, move: object, fact: (name: string) => boolean) => boolean} holds - Pure; `fact` derives a declared read.
 */

/**
 * @typedef {object} Rule
 * @property {string} name
 * @property {string} says
 * @property {readonly string[]} reads
 * @property {RuleDefinition['holds']} holds
 */

/**
 * Define the named rules once, refusing any that read an undefined fact or form a cycle.
 * Why: a bad rule set is caught when it is written, so no move ever meets it half way through.
 *
 * @param {Record<string, RuleDefinition>} definitions
 * @returns {Readonly<Record<string, Rule>>}
 */
export function defineRules(definitions) {
  const rules = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (typeof definition?.says !== 'string' || !definition.says.trim() || typeof definition.holds !== 'function') {
      throw new Refused('RULE_SHAPE', `rule ${name} needs says (words) and holds (a function)`, 'give the rule a says sentence and a pure holds(snapshot, move, fact)');
    }
    rules[name] = Object.freeze({ name, says: definition.says, reads: Object.freeze([...(definition.reads ?? [])]), holds: definition.holds });
  }
  for (const rule of Object.values(rules)) {
    for (const read of rule.reads) {
      if (!Object.hasOwn(rules, read)) throw new Refused('RULE_UNDEFINED', `rule ${rule.name} reads ${read}, which no rule defines`, `define ${read}, or drop it from ${rule.name}'s reads`);
    }
  }
  refuseCycles(rules);
  return Object.freeze(rules);
}

/** Refuse RULE_CYCLE when a rule reaches itself through its reads. */
function refuseCycles(rules) {
  const done = new Set();
  const visit = (name, path) => {
    if (path.includes(name)) throw new Refused('RULE_CYCLE', `rules read each other in a cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`, 'break the cycle so each fact derives from facts below it');
    if (done.has(name)) return;
    for (const read of rules[name].reads) visit(read, [...path, name]);
    done.add(name);
  };
  for (const name of Object.keys(rules)) visit(name, []);
}

/**
 * Derive one named fact over a frozen snapshot and move, with a trace of every fact it read.
 * Each fact is derived at most once per call; the trace lists them in the order they settled, the asked fact last.
 *
 * @param {Readonly<Record<string, Rule>>} rules - From defineRules.
 * @param {string} name
 * @param {object} snapshot - Frozen here if it is not already, so a rule that writes to it fails.
 * @param {object} [move]
 * @returns {{ fact: string, holds: boolean, trace: { fact: string, holds: boolean }[] }}
 */
export function deriveFact(rules, name, snapshot, move = {}) {
  deepFreeze(snapshot);
  deepFreeze(move);
  const settled = new Map();
  const trace = [];
  const derive = (current) => {
    if (settled.has(current)) return settled.get(current);
    const rule = rules[current];
    if (!rule) throw new Refused('RULE_UNDEFINED', `no rule defines ${current}`, `define ${current} in the rules, or ask for a defined fact`);
    const fact = (read) => {
      if (!rule.reads.includes(read)) throw new Refused('RULE_UNDECLARED_READ', `rule ${current} read ${read} without declaring it`, `add ${read} to ${current}'s reads`);
      return derive(read);
    };
    const holds = rule.holds(snapshot, move, fact);
    if (typeof holds !== 'boolean') throw new Refused('RULE_NOT_BOOLEAN', `rule ${current} returned ${typeof holds}, not true or false`, `make ${current}'s holds return a boolean`);
    settled.set(current, holds);
    trace.push({ fact: current, holds });
    return holds;
  };
  const holds = derive(name);
  return { fact: name, holds, trace };
}

/** The values of an item's landing dimension, beside its status [M1,M4]. */
export const LANDINGS = Object.freeze(['none', 'landed', 'pulling', 'published']);

/**
 * The landing events, newest last: pull_out starts a pull-out, pulled ends it (the revert is recorded), published makes it final [M1,M2].
 * merged (null) defers to the merged commit, so a sprint item landed again after a pull-out reads landed, not none.
 */
const LANDING_EVENTS = Object.freeze({ pull_out: 'pulling', pulled: 'none', published: 'published', merged: null });

/**
 * The item's landing value, derived: the newest landing event's value when the history holds one (pull_out: pulling, pulled: none,
 * published: published), else landed once it has a landing receipt (a merged commit), else none.
 * Why: landing is its own dimension of item state, not a flag on a verified item; the merged commit records landed, and only a
 * Sprint item ever gets a pull_out or published event, so a Steady item's landing is exactly what its merged commit says.
 *
 * @param {{ mergedCommit?: string | null, merged?: boolean } | null | undefined} item - A table snapshot's item.
 * @param {{ kind: string }[]} [history] - The item's events, oldest first; absent reads as none.
 * @returns {'none' | 'landed' | 'pulling' | 'published'}
 */
export function landingOf(item, history = []) {
  const last = (Array.isArray(history) ? history : []).findLast(event => Object.hasOwn(LANDING_EVENTS, event?.kind));
  if (last && LANDING_EVENTS[last.kind] !== null) return LANDING_EVENTS[last.kind];
  return item?.mergedCommit || item?.merged === true ? 'landed' : 'none';
}

/** Freeze a plain value and everything under it, stopping at anything already frozen. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
