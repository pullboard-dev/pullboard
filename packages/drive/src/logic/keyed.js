/** Pure naming and reading of keyed-result jobs: a derived result is one job per (kind, content key) [C7]. */

/** The job kind that produces a tree's cells inventory (RFC 0008 DJ22). */
export const CELLS_INVENTORY_KIND = 'cells-inventory';

/** The step that holds a keyed job's finished result; written once, so every later reader gets the same answer. */
export const RESULT_STEP = 'result';

/** The step a driver writes each time it starts producing, one seq per attempt. */
export const STARTED_STEP = 'produce.started';

/** Saved partial work is a step named with this prefix, so a resumed producer skips what a dead one finished. */
export const PART_PREFIX = 'part.';

/**
 * The job id of one derived result: its kind and its content key.
 *
 * Why: the key is content (a tree id, or a tree plus a command), so every gate on the same tree names the same job
 * and the result is computed once, whichever driver needs it first.
 *
 * @param {string} kind - The job kind, such as cells-inventory.
 * @param {string} key - The content key, such as a tree id.
 * @returns {string}
 */
export function keyedJobId(kind, key) {
  return `${kind}:${key}`;
}

/**
 * The stored result of a keyed job, or undefined when no driver has finished it.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view - A jobView.
 * @returns {{ result: any, owner: string | null } | undefined}
 */
export function storedResult(view) {
  const step = view.steps.find(row => row.name === RESULT_STEP);
  // A pruned result (only its hash and size remain) is no result: the next driver produces it again.
  return step && !step.payload.pruned ? { result: step.payload.result, owner: step.payload.owner ?? null } : undefined;
}

/**
 * The partial work earlier drivers saved, by part name.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view - A jobView.
 * @returns {Map<string, any>}
 */
export function savedParts(view) {
  return new Map(view.steps.filter(row => row.name.startsWith(PART_PREFIX)).map(row => [row.name.slice(PART_PREFIX.length), row.payload]));
}

/**
 * How many times a driver started producing this job, which is also the seq of the next start.
 *
 * @param {{ steps: { name: string }[] }} view - A jobView.
 * @returns {number}
 */
export function attemptsOf(view) {
  return view.steps.filter(row => row.name === STARTED_STEP).length;
}
