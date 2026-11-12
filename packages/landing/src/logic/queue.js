/** The landing queue planner: chain accepted arrivals into candidates, each built on the one before it [C7]. */

/** Most candidates in flight at once: past this depth a red near the head rebuilds too much speculative work. */
export const CHAIN_DEPTH = 4;

/**
 * Plan the next landing candidates, purely. Every item that arrived since the last candidate becomes one new batch;
 * its parent is the newest candidate still in flight, or main when none is. Later arrivals wait until a slot frees,
 * then join the next batch, so the chain never grows past `depth`. Each candidate carries `below`, the items of every
 * candidate under it in order, which is the tree it speculates on until its parent lands.
 *
 * @param {{ arrivals: number[], inFlight?: { id: string, items: number[], below?: number[] }[], depth?: number,
 *   name?: (index: number) => string }} queue - arrivals: accepted item ids in arrival order, not yet in a candidate.
 * @returns {{ candidates: { id: string, parent: string | null, items: number[], below: number[] }[], waiting: number[] }}
 *   candidates: the new candidates to offer, oldest first; waiting: arrivals left for a later plan.
 */
export function planQueue({ arrivals, inFlight = [], depth = CHAIN_DEPTH, name = index => `candidate-${index}` }) {
  const seen = new Set(inFlight.flatMap(candidate => candidate.items));
  const fresh = [...new Set(arrivals)].filter(id => !seen.has(id));
  const top = inFlight.at(-1) ?? null;
  if (fresh.length === 0 || inFlight.length >= depth) return { candidates: [], waiting: fresh };
  const candidate = {
    id: name(inFlight.length + 1),
    parent: top?.id ?? null,
    items: fresh,
    below: top ? [...(top.below ?? []), ...top.items] : [],
  };
  return { candidates: [candidate], waiting: [] };
}

/**
 * Plan a queue whose arrivals came in separate batches (one batch per plan tick), up to the depth cap. A helper for
 * replays and tests: the board calls planQueue once per accept, which is the same thing one tick at a time.
 *
 * @param {number[][]} batches - arrivals grouped by the tick they arrived in.
 * @param {{ depth?: number, name?: (index: number) => string }} [options]
 * @returns {{ candidates: { id: string, parent: string | null, items: number[], below: number[] }[], waiting: number[] }}
 */
export function planBatches(batches, { depth = CHAIN_DEPTH, name } = {}) {
  const inFlight = [];
  let waiting = [];
  for (const batch of batches) {
    const plan = planQueue({ arrivals: [...waiting, ...batch], inFlight, depth, name });
    inFlight.push(...plan.candidates);
    waiting = plan.waiting;
  }
  return { candidates: inFlight, waiting };
}
