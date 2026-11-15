/**
 * Replay a board's whole event log through the lifecycle rules and report where the rules and the board disagree [C7].
 * Why: every disagreement is either a rule bug or a board bug, and both are worth knowing (U152 trial); the replay
 * changes nothing, it only reads facts and compares. Pure: facts in, a report out.
 */
import { apply } from './rules.js';
import { judge } from './rules.js';
import { leaseLive } from './rules.js';
import { newItem } from './rules.js';
import { readiness } from './rules.js';
import { ruleOf } from './rules.js';

/** The moves that run the clock's lapse first: after a lease ends, the board treats the claim as gone. */
export const SKIPS_LAPSE = new Set(['claim', 'renew', 'release', 'withdraw', 'hold', 'unhold', 'refreeze', 'edit-after', 'merged', 'review-landed']);

/**
 * Turn one event row into a lifecycle fact.
 *
 * @param {{ id: number, at: string, by: string, kind: string, item: number, after?: string | null, leaseUntil?: string | null,
 *   retained?: number | null, review?: number | null, forced?: number | null, maintenance?: number | null,
 *   fromState?: string | null, blockedOn?: string | null }} row
 * @returns {object} The fact, with only what the rules read.
 */
export function lifecycleFact(row) {
  const ids = text => {
    if (typeof text !== 'string') return null;
    try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : null; }
    catch { return null; /* malformed legacy detail carries no dependencies */ }
  };
  return { id: row.id, at: row.at, by: row.by, kind: row.kind, item: row.item, after: ids(row.after), blockedOn: ids(row.blockedOn), from: row.fromState ?? null, leaseUntil: row.leaseUntil ?? null,
    retainedClaim: Boolean(row.retained), review: Boolean(row.review), forced: Boolean(row.forced), maintenance: Boolean(row.maintenance) };
}

/** The disagreement's family: the rule and the refusal code, with ids stripped so like cases group. */
const kindOf = (rule, verdict) => `${rule ?? 'unknown'}: ${verdict.code}`;

/**
 * Replay every fact in id order. A refused move is still applied, since the board did it, so one disagreement
 * never hides the ones after it.
 *
 * @param {object[]} facts - Lifecycle facts in event id order.
 * @returns {{ judged: number, agreed: number, disagreements: object[], byRule: Record<string, { judged: number, agreed: number }>, items: Map<number, object> }}
 */
export function replay(facts) {
  const items = new Map();
  const disagreements = [];
  const byRule = {};
  let agreed = 0;
  for (const fact of facts) {
    const rule = ruleOf(fact);
    let item = items.get(fact.item);
    if (!item) { item = fact.kind === 'add' ? newItem(fact.item, fact.after ?? []) : { ...newItem(fact.item), created: false }; items.set(fact.item, item); }
    if (fact.kind === 'add') {
      // The add itself: the item must not already have been created by an earlier add.
      const again = item.lastEvent !== null;
      const row = (byRule.add ??= { judged: 0, agreed: 0 });
      row.judged++;
      if (again) disagreements.push({ event: fact.id, item: fact.item, by: fact.by, at: fact.at, rule: 'add', kind: 'add: ALREADY_ADDED', why: 'an item was added twice' });
      else { row.agreed++; agreed++; }
      items.set(fact.item, { ...item, lastEvent: fact.id });
      continue;
    }
    if (fact.kind === 'edit' && !fact.after) continue;
    if (item.status === 'claimed' && !SKIPS_LAPSE.has(rule) && !leaseLive(item, fact.at) && item.leaseUntil) item = { ...item, status: 'open', owner: null, leaseUntil: null, lapsed: true };
    const verdict = judge(item, fact, items);
    const row = (byRule[verdict.rule ?? 'unknown'] ??= { judged: 0, agreed: 0 });
    row.judged++;
    if (verdict.ok) { row.agreed++; agreed++; }
    else disagreements.push({ event: fact.id, item: fact.item, by: fact.by, at: fact.at, rule: verdict.rule, kind: kindOf(verdict.rule, verdict), why: verdict.why });
    items.set(fact.item, apply(item, fact, verdict.rule));
  }
  const judged = Object.values(byRule).reduce((sum, row) => sum + row.judged, 0);
  return { judged, agreed, disagreements, byRule, items };
}

/**
 * Compare where the replay left each item with what the board's item rows say now.
 *
 * @param {Map<number, object>} items - From replay().
 * @param {{ id: number, status: string, owner: string | null, held: boolean, after: number[] }[]} rows - The board's item rows.
 * @returns {{ compared: number, agreed: number, mismatches: { item: number, kind: string, derived: string, board: string, lastEvent: number | null }[] }}
 */
export function compareFinal(items, rows) {
  const mismatches = [];
  let agreed = 0;
  for (const row of rows) {
    const item = items.get(row.id);
    const found = [];
    if (!item) found.push(['no events', 'no events', row.status]);
    else {
      if (item.status !== row.status) found.push(['status', item.status, row.status]);
      else if (row.status === 'claimed' && item.owner !== row.owner) found.push(['owner', String(item.owner), String(row.owner)]);
      if (item.held !== row.held) found.push(['hold', String(item.held), String(row.held)]);
      if (item.after.join(',') !== row.after.join(',')) found.push(['after', item.after.join(','), row.after.join(',')]);
    }
    if (!found.length) agreed++;
    for (const [what, derived, board] of found) mismatches.push({ item: row.id, kind: what === 'status' ? `final status: rules say ${derived}, board says ${board}` : `final ${what}`, derived, board, lastEvent: item?.lastEvent ?? null });
  }
  return { compared: rows.length, agreed, mismatches };
}

/**
 * The derived readiness counts at the end of the log, from the rules alone.
 *
 * @param {Map<number, object>} items
 * @returns {{ open: number, ready: number, blocked: number, held: number }}
 */
export function readinessCounts(items) {
  const counts = { open: 0, ready: 0, blocked: 0, held: 0 };
  for (const item of items.values()) {
    if (item.status !== 'open') continue;
    const state = readiness(item, items);
    counts.open++;
    if (state.ready) counts.ready++;
    if (state.blocked) counts.blocked++;
    if (state.held) counts.held++;
  }
  return counts;
}

/**
 * Group disagreements by family, most common first, each with how many, the first and last event, and an example.
 *
 * @param {{ kind: string, event: number, item: number, why: string }[]} disagreements
 * @returns {{ kind: string, count: number, first: number, last: number, example: object }[]}
 */
export function topKinds(disagreements) {
  const groups = new Map();
  for (const entry of disagreements) {
    const group = groups.get(entry.kind) ?? { kind: entry.kind, count: 0, first: entry.event, last: entry.event, example: entry };
    group.count++;
    group.last = entry.event;
    groups.set(entry.kind, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * The whole trial in one call: replay the facts, compare the final state, and summarize.
 *
 * @param {object[]} facts
 * @param {object[]} itemRows
 * @returns {object} The report: judged, agreed, rate, disagreements, kinds, final comparison and readiness counts.
 */
export function trial(facts, itemRows) {
  const run = replay(facts);
  const final = compareFinal(run.items, itemRows);
  return {
    judged: run.judged, agreed: run.agreed, rate: run.judged ? run.agreed / run.judged : 1,
    disagreements: run.disagreements, kinds: topKinds(run.disagreements), byRule: run.byRule,
    final: { compared: final.compared, agreed: final.agreed, rate: final.compared ? final.agreed / final.compared : 1, mismatches: final.mismatches, kinds: topKinds(final.mismatches.map(m => ({ kind: m.kind, event: m.lastEvent ?? 0, item: m.item, why: `${m.derived} vs ${m.board}` }))) },
    readiness: readinessCounts(run.items),
  };
}
