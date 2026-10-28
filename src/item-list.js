/** Shared local/relay item-list fields, derived once from the declared lifecycle [A2,N26,H17]. */
import { MACHINE } from './machine.js';

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
  'blockedBy', 'updatedAt', 'stage', 'since', 'counts', 'imported', 'verdict', 'verdictState']);
export const SUMMARY_KEYS = new Set(SUMMARY_FIELDS);
const CLOCK_MOVES = MACHINE.moves.filter((move) => move.by.includes('clock'));

/** Preserve the lifecycle facts recorded by the board without exposing unrelated event details. */
export function lifecycleEvent(event) {
  const projected = { kind: event.event_kind, by: event.event_by, at: event.event_at };
  if (event.event_kind === 'refreeze' && JSON.parse(event.event_detail).retainedClaim === true) projected.retainedClaim = true;
  return projected;
}

/** Match a recorded event to its declared move, including state-specific native aliases. */
export function lifecycleMove(machine, state, event) {
  const aliases = { renew: 'claim', 'merge-only-accept': 'submit-merge', rehome_import: 'rehomeImport', 'outside-intake': 'intake' };
  const verb = ['item_patch_attach', 'item_patch_remove'].includes(event.kind)
    ? state === 'claimed' ? 'patch-claimed' : 'patch' : aliases[event.kind] ?? event.kind;
  return machine.moves.find(move => move.verb === verb && move.from.includes(state)
    && (verb !== 'claim' || (event.kind === 'renew') === (move.to === state))
    && (verb !== 'refreeze' || (event.retainedClaim === true) === (move.to === 'claimed')));
}

/**
 * Replay an item's recorded events through the declared lifecycle, as the view's timeline does
 * (M1). The board logs a claim on a claimed item as renew, and never the clock's lapse, so a move
 * that cannot start where the replay stands, or a status the history does not reach, puts the
 * lapse in first.
 *
 * @param {{ kind: string, at: string }[]} history
 * @param {string} status
 * @returns {{ from: string, move: object | null, at: string | null }[]}
 */
function lifecycleSteps(history, status) {
  const steps = [];
  let at = MACHINE.initial;
  /** Record where the replay stands and the move it makes, if any, then follow that move. */
  const step = (move, event) => {
    steps.push({ from: at, move, at: event ? event.at : null });
    if (move) at = move.to;
  };
  for (const event of history) {
    /** Use the same native-event matcher as snapshot replay. */
    const fits = state => lifecycleMove(MACHINE, state, event);
    const lapse = fits(at) ? null : CLOCK_MOVES.find((move) => move.from.includes(at) && fits(move.to));
    if (lapse) step(lapse, null);
    step(fits(at) || null, event);
  }
  const lapse = at === status ? null : CLOCK_MOVES.find((move) => move.from.includes(at) && move.to === status);
  if (lapse) step(lapse, null);
  return steps;
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
      const steps = lifecycleSteps(item.history, item.status);
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
  const sentBack = item.verdict?.decision === 'REJECT' && item.status !== 'verified';
  summary.verdict = item.verdict && { decision: item.verdict.decision, reason: item.verdict.reason,
    ...(sentBack ? { note: String(item.verdict.note ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '' } : {}) };
  return summary;
}
