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
