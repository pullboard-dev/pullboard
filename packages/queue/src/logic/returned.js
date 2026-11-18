/** Returned work first: abandoned and reworked items are offered ahead of untouched ones of their rank [C7,#2220]. */

/** The stop reasons whose items are not offered at all until something else changes. */
const HELD = new Set(['wall', 'decision', 'blocked']);
/** The stop reasons whose items come back ahead of untouched work. */
const RETURNED = new Set(['abandoned', 'rework']);

/**
 * The queue with returned items moved ahead of untouched items of the same or lower rank, and held items left out.
 * Why: an abandoned or reworked item already has work and context in it, so finishing it is cheaper than starting fresh work;
 * an item stopped on a wall, a decision or a blocker would only bounce back, so it is not offered.
 * Rank is a number, lower meaning more urgent; an item with no rank counts as 0. Order inside each group is kept.
 * @param {{ id: number, rank?: number }[]} queue
 * @param {Record<number, string>} reasons item id to the value stopReason returns
 */
export function returnedFirst(queue, reasons) {
  const rank = entry => entry.rank ?? 0;
  const returned = entry => RETURNED.has(reasons?.[entry.id]);
  return queue
    .filter(entry => !HELD.has(reasons?.[entry.id]))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || Number(returned(b.entry)) - Number(returned(a.entry)) || a.index - b.index)
    .map(({ entry }) => entry);
}
