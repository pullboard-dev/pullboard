/** Whether a red batch is cheaper to split into singles or to bisect, from its own measured gate [C7]. */

/**
 * The estimated cost of each way of resolving a red batch of `items` items, in the same unit as `gateMs`.
 *
 * Split: every item lands on its own full gate, so `items` gates. Bisect: each level gates two halves on the failing
 * files only, then the green set runs its whole plan once more. A focused half still pays the gate's fixed part
 * (merge, plan, runner setup); only the run part shrinks with the share of the plan it keeps.
 *
 * @param {{ items: number, gateMs: number, fixedMs?: number, focusShare?: number }} measured
 *   items: how many items the batch holds; gateMs: the batch's full gate wall time; fixedMs: the part of it that a
 *   focused run pays regardless (default half); focusShare: the share of the plan the failing files make (default 0.1).
 * @returns {{ splitMs: number, bisectMs: number, levels: number }}
 */
export function redBatchCosts({ items, gateMs, fixedMs = gateMs / 2, focusShare = 0.1 }) {
  const levels = Math.max(1, Math.ceil(Math.log2(Math.max(2, items))));
  const fixed = Math.min(Math.max(0, fixedMs), gateMs);
  const focused = fixed + Math.min(1, Math.max(0, focusShare)) * (gateMs - fixed);
  return { splitMs: items * gateMs, bisectMs: 2 * levels * focused + gateMs, levels };
}

/**
 * True when splitting a red batch into singles is no dearer than bisecting it. Why: the choice is arithmetic on the
 * batch's own numbers, not a fixed threshold; with today's fixed cost near half the gate a pair splits and four or
 * more bisect, and the numbers are recorded with the decision so the choice can be audited [C7].
 */
export function splitBeatsBisect(measured) {
  const costs = redBatchCosts(measured);
  return { split: costs.splitMs <= costs.bisectMs, ...costs };
}
