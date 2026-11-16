/** Read the board's events as hourly seat-count rows and name the max useful builder count over the trailing window [C7,#8544]. */
import { maxUsefulBuilders } from '../logic/capacity/useful.js';
import { USEFUL_WINDOW_MS } from '../logic/capacity/useful.js';

const HOUR_MS = 3_600_000;
const SYSTEM_ACTORS = ['board', 'person', 'clock', 'coordinator', 'rigor', 'sentinel'];
const CHURN_KINDS = ['reject', 'reopen', 'release'];

/**
 * Max useful builders from the event table: one history row per hour with active seats, merged items as landings, and
 * rejects, reopens and releases as churn.
 *
 * Why: status shows the answer with its window and inputs, so a reader sees which seat counts were observed and never
 * mistakes an unknown for zero. The read is query-only.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now - epoch milliseconds, passed in so the answer is repeatable
 * @returns {ReturnType<typeof maxUsefulBuilders>}
 */
export function readMaxUsefulBuilders(db, now) {
  const from = now - USEFUL_WINDOW_MS;
  const rows = db.prepare('SELECT event_kind AS kind, event_by AS seat, event_at AS at FROM event WHERE event_at > ? AND event_at <= ?')
    .all(new Date(from).toISOString(), new Date(now).toISOString());
  const hours = new Map();
  for (const row of rows) {
    const hour = Math.floor(Date.parse(row.at) / HOUR_MS) * HOUR_MS;
    const cell = hours.get(hour) ?? { at: hour, seats: new Set(), landings: 0, churn: 0 };
    if (row.kind === 'merged') cell.landings += 1;
    if (CHURN_KINDS.includes(row.kind)) cell.churn += 1;
    if (row.seat && !SYSTEM_ACTORS.includes(row.seat)) cell.seats.add(row.seat);
    hours.set(hour, cell);
  }
  const history = [...hours.values()].map(cell => ({ at: cell.at + HOUR_MS - 1, seats: cell.seats.size, landings: cell.landings, churn: cell.churn }));
  return maxUsefulBuilders(history, { now });
}
