/** Max useful builder seats from marginal landings per added seat and churn over a trailing window [C7]. */

const HOUR = 3_600_000;
export const USEFUL_WINDOW_MS = 7 * 24 * HOUR;
export const USEFUL_MIN_MARGINAL = 0.05;

/**
 * Compute how many builder seats still add landed work.
 *
 * Why: the planner gives a recommended range, but not why a further seat stops paying. Each history row is one
 * observed hour with the builder seats that were active, the items that landed and the churn (rejects, reverts and
 * re-claims). Net landings are landings minus churn, averaged per seat count over the trailing window; the marginal
 * value of the k-th seat is the net-landing rate at k seats minus the rate at the nearest lower observed count.
 * The answer is the highest observed count whose marginal stays at or above `minMarginal`, with no lower count
 * failing it; seat counts never observed are never guessed.
 *
 * @param {Array<{ at: number|string, seats: number, landings: number, churn?: number }>} history
 * @param {{ now: number|string, windowMs?: number, minMarginal?: number }} options - `now` is explicit: no clock is read.
 * @returns {{ max: number|null, window: { from: number, to: number }, inputs: { rows: number, counts: number[] }, curve: Array<{ seats: number, hours: number, netPerHour: number, marginal: number|null }> }}
 *   `max` is null when fewer than two seat counts were observed in the window (unknown, not zero).
 */
export function maxUsefulBuilders(history, { now, windowMs = USEFUL_WINDOW_MS, minMarginal = USEFUL_MIN_MARGINAL }) {
  const to = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(to)) throw new TypeError('now must be a time');
  const from = to - windowMs;
  const rows = history.filter(row => {
    const at = typeof row.at === 'number' ? row.at : Date.parse(row.at);
    return at > from && at <= to && Number.isSafeInteger(row.seats) && row.seats > 0 && Number.isFinite(row.landings) && row.landings >= 0;
  });
  const byCount = new Map();
  for (const row of rows) {
    const cell = byCount.get(row.seats) ?? { hours: 0, net: 0 };
    cell.hours += 1;
    cell.net += row.landings - (Number.isFinite(row.churn) && row.churn > 0 ? row.churn : 0);
    byCount.set(row.seats, cell);
  }
  const counts = [...byCount.keys()].sort((a, b) => a - b);
  let previous = null;
  const curve = counts.map(seats => {
    const cell = byCount.get(seats);
    const netPerHour = cell.net / cell.hours;
    const marginal = previous === null ? null : (netPerHour - previous.netPerHour) / (seats - previous.seats);
    const point = { seats, hours: cell.hours, netPerHour, marginal };
    previous = point;
    return point;
  });
  const inputs = { rows: rows.length, counts };
  if (curve.length < 2) return { max: null, window: { from, to }, inputs, curve };
  let max = curve[0].seats;
  for (const point of curve.slice(1)) {
    if (point.marginal < minMarginal) break;
    max = point.seats;
  }
  return { max, window: { from, to }, inputs, curve };
}

/**
 * Print the max useful builder answer with its window and inputs.
 *
 * Why: a bare number hides how little it rests on; the line names the window, the hours read and the seat counts seen.
 *
 * @param {ReturnType<typeof maxUsefulBuilders>} result
 * @returns {string[]}
 */
export function usefulBuilderLines(result) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const inputs = `${result.inputs.rows} observed hours at seat counts ${result.inputs.counts.length ? result.inputs.counts.join(', ') : 'none'}`;
  const window = `${day(result.window.from)} to ${day(result.window.to)}`;
  return [result.max === null
    ? `Max useful builders: unknown (needs two observed seat counts; window ${window}; ${inputs}).`
    : `Max useful builders: ${result.max} (window ${window}; ${inputs}).`];
}

/* The staffing rule: how many builder and review seats the board runs, 8 builders to 1 reviewer by default [C7,#12397]. */
/** Builders per reviewer when the caller names no ratio. */
export const STAFFING_RATIO = 8;

/**
 * The builder and review seats to run: builders are the ready items capped by the max useful builders when that is known,
 * and reviewers are one per `ratio` builders, rounded up, with at least one whenever any builder runs.
 *
 * @param {{ ready: number, maxUseful?: number | null, ratio?: number }} input the ready item count, the max useful builders (null when unknown) and the builders per reviewer
 * @returns {{ builders: number, reviewers: number, ratio: number }}
 */
export function staffingSeats({ ready, maxUseful = null, ratio = STAFFING_RATIO }) {
  const open = Number.isFinite(ready) && ready > 0 ? Math.floor(ready) : 0;
  const cap = Number.isFinite(maxUseful) && maxUseful >= 0 ? Math.floor(maxUseful) : open;
  const builders = Math.min(open, cap);
  const per = Number.isFinite(ratio) && ratio > 0 ? ratio : STAFFING_RATIO;
  return { builders, reviewers: builders > 0 ? Math.max(1, Math.ceil(builders / per)) : 0, ratio: per };
}

/**
 * The one status line naming the builder seats, the review seats and the ratio.
 *
 * @param {{ builders: number, reviewers: number, ratio: number }} seats the answer of staffingSeats
 * @returns {string}
 */
export function staffingLines(seats) {
  const noun = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return `Staffing: ${noun(seats.builders, 'builder')}, ${noun(seats.reviewers, 'reviewer')} (${seats.ratio}:1)`;
}
