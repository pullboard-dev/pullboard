/** Shared local/relay item-list fields, derived once from the declared lifecycle [A2,N26,H17]. */
import { MACHINE } from "../../../state/light.js";
import { Refused } from "../../../kernel/light.js";
import { lifecycleSteps } from "./lifecycle.js";
import { recordedWithdrawalFrom } from "./lifecycle.js";
export { lifecycleEvent } from "./lifecycle.js";
export { lifecycleMove } from "./lifecycle.js";

/** Match the first local milestone name exactly as the state list projection does. */
export function milestoneNamesByItem(milestones) {
  const names = new Map();
  for (const milestone of milestones ?? []) {
    for (const entry of milestone.items ?? []) {
      const id = typeof entry === 'number' ? entry : entry?.id;
      if (typeof id === 'number' && !names.has(id)) names.set(id, milestone.name);
    }
  }
  return names;
}

/** What a board-state item summary keeps: what the lists and the roadmap read (A2, N26). */
const SUMMARY_FIELDS = Object.freeze(['id', 'title', 'lane', 'status', 'route', 'milestone', 'specs', 'claim', 'builtBy',
  'blockedBy', 'progress', 'updatedAt', 'stage', 'since', 'counts', 'imported', 'verdict', 'verdictState', 'withdrawnReason', 'withdrawnFrom']);
export const SUMMARY_KEYS = new Set(SUMMARY_FIELDS);

/** Derive the withdrawal origin through the same canonical lifecycle used by list stages. */
export function withdrawnFrom(history, status) {
  return recordedWithdrawalFrom(MACHINE, history, status);
}

/** When an item arrived in its list stage; edits, review reservations and renewals do not restart it. */
function stageSince(item, steps) {
  if (item.merged) return item.history.findLast((event) => event.kind === 'merged')?.at || item.updatedAt;
  const arrival = steps.findLast((step) => step.move && step.from !== step.move.to);
  // A lapse is inferred, but the claim's own receipt records the deadline that caused it.
  if (arrival?.move?.verb === 'lapse') {
    const claim = item.thread.findLast((entry) => entry.type === 'move' && ['claim', 'renew'].includes(entry.kind));
    if (claim?.detail?.leaseUntil) return claim.detail.leaseUntil;
  }
  return arrival ? arrival.at || item.updatedAt : item.history.find((event) => event.kind === 'add')?.at || item.updatedAt;
}

/**
 * Give every item what its list rows read without its history: its list stage and when it entered
 * it, its roadmap milestone, the live lease on it, and its verdict and fact counts. A recorded merge,
 * not an accept, ends the pipeline. The board's moves are tallied once, keyed from>to:verb as the
 * lifecycle drawing sums them.
 *
 * @param {any} state
 * @param {Map<number, string | null>} leases Each item's recorded claim deadline.
 * @returns {any}
 */
export function withListFields(state, leases, { previous = null, dirtyIds = new Set(state.items.map((item) => item.id)) } = {}) {
  const milestones = milestoneNamesByItem(state.milestones);
  const moveCounts = {};
  const itemMoveCounts = new Map();
  const items = state.items.map((item) => {
    let contribution = previous?.itemMoveCounts.get(item.id);
    let projected = item;
    if (!previous || dirtyIds.has(item.id) || !previous.items.has(item.id)) {
      const steps = lifecycleSteps(MACHINE, item.history, item.status);
      contribution = {};
      for (const step of steps) {
        const key = step.move && step.from + '>' + step.move.to + ':' + step.move.verb;
        if (key) contribution[key] = (contribution[key] ?? 0) + 1;
      }
      // Who holds the item under a live lease: its builder while claimed, its reviewer while reserved.
      const claim = item.status === 'claimed' && item.owner ? { by: item.owner, until: leases.get(item.id) ?? null }
        : item.status === 'submitted' && item.reviewer ? { by: item.reviewer, until: item.reviewUntil } : null;
      projected = { ...item,
        milestone: milestones.get(item.id) ?? null,
        claim,
        stage: item.merged ? 'merged' : item.status === 'verified' ? 'accepted' : item.status,
        since: stageSince(item, steps),
        counts: { verdicts: item.verdicts.length, facts: item.thread.filter((entry) => entry.type === 'fact').length },
      };
    }
    contribution ??= {};
    itemMoveCounts.set(item.id, contribution);
    for (const [key, count] of Object.entries(contribution)) moveCounts[key] = (moveCounts[key] ?? 0) + count;
    return projected;
  });
  return { state: { ...state, items, moveCounts }, itemMoveCounts };
}

/**
 * Keep the summary fields. The latest verdict keeps its decision and reason, and, for an item sent
 * back and not verified, the first line of its note, which the Items list shows beside the reason.
 */
export function itemSummary(item) {
  const summary = Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, item[key]]));
  // A starter's waiting blueprint-fit proposal is a summary field only when one exists, so other summaries keep their shape [S1,E3].
  if (item.fit !== undefined) summary.fit = item.fit;
  const sentBack = item.verdict?.decision === 'REJECT' && item.status !== 'verified';
  summary.verdict = item.verdict && { decision: item.verdict.decision, reason: item.verdict.reason,
    ...(sentBack ? { note: String(item.verdict.note ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '' } : {}) };
  return summary;
}

/** The comparison operators a `--field` filter takes, longest first so `>=` is not read as `>`. */
const FIELD_OPERATORS = Object.freeze(['>=', '<=', '!=', '=', '>', '<']);

/**
 * Parse a `--field` filter such as `priority=high` or `points>=3` into its name, operator and value text.
 * Why here: the filter is pure, so the thin and full list paths and the relay list can share one reading of it [C7,#9353].
 *
 * @param {string} text
 * @returns {{ name: string, op: string, value: string }}
 */
export function parseFieldFilter(text) {
  const match = /^([a-z][a-z0-9_-]{0,31})(>=|<=|!=|=|>|<)(.*)$/u.exec(String(text));
  if (!match || !FIELD_OPERATORS.includes(match[2]) || match[3] === '') {
    throw new Refused('FIELD_FILTER', `${JSON.stringify(String(text))} is not a field filter`, 'write --field <name><op><value>, such as --field priority=high or --field points>=3');
  }
  return { name: match[1], op: match[2], value: match[3] };
}

/**
 * Keep the items whose typed field satisfies the filter. An item with no value for the field never matches.
 * An unknown field name refuses with its next step; a number field compares as a number, others as text with = and !=.
 *
 * @param {{ id?: number, item_id?: number }[]} items
 * @param {string} text - the `--field` argument.
 * @param {{ types: Map<string, string>, values: Map<number, Map<string, string | number>> }} index - from the store's fieldIndex.
 * @returns {any[]}
 */
export function filterByField(items, text, index) {
  const { name, op, value } = parseFieldFilter(text);
  const type = index.types.get(name);
  if (!type) {
    const known = [...index.types.keys()].sort();
    throw new Refused('FIELD_UNKNOWN', `no field named ${name} is declared`, known.length ? `use one of: ${known.join(', ')}; or declare it with pullboard field declare` : 'declare it first with pullboard field declare <name> <text|choice|number>');
  }
  const wanted = type === 'number' ? Number(value) : value;
  if (type === 'number' && !Number.isFinite(wanted)) throw new Refused('FIELD_FILTER', `field ${name} is a number; ${JSON.stringify(value)} is not`, `compare it with a number, such as --field ${name}${op}3`);
  if (type !== 'number' && !['=', '!='].includes(op)) throw new Refused('FIELD_FILTER', `field ${name} is ${type}; ${op} compares numbers only`, `use = or != with a ${type} field`);
  const holds = {
    '=': (have) => have === wanted, '!=': (have) => have !== wanted,
    '>': (have) => have > wanted, '>=': (have) => have >= wanted, '<': (have) => have < wanted, '<=': (have) => have <= wanted,
  }[op];
  return items.filter((item) => {
    const own = index.values.get(item.id ?? item.item_id);
    return own?.has(name) && holds(own.get(name));
  });
}
