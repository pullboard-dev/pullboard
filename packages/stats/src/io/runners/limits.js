/** Record and read back the changes to the machine limits that bound work, for the runner statistics [C7,#6139]. */

/** The event kind a limit change is recorded under. */
export const LIMIT_EVENT = 'machine_limit';

/**
 * Append one timestamped board event holding a limit's key, old and new value; nothing when the value did not change.
 *
 * Why: machine settings are config with no history, so later analysis of runner speed could not know the limits in effect.
 * The caller passes store's atomic and logEvent: stats sits below store and may not import it, or the cells close a cycle [C7,CD23].
 *
 * @param {any} board - An open board, writable.
 * @param {string} key - gateSlots, workers.budget or runner.jobs.
 * @param {unknown} before - The value before the change; null when none was recorded.
 * @param {unknown} after - The value after it.
 * @param {{ atomic: Function, logEvent: Function }} store - Store's write primitives.
 * @returns {boolean} whether an event was written.
 */
export function recordLimitChange(board, key, before, after, { atomic, logEvent }) {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return false;
  atomic(board, () => logEvent(board, 'machine', LIMIT_EVENT, null, { key, old: before ?? null, new: after ?? null }));
  return true;
}

/**
 * The newest recorded value of one limit, or null when none was recorded.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {unknown}
 */
export function lastLimit(db, key) {
  for (const row of db.prepare('SELECT event_detail FROM event WHERE event_kind = ? ORDER BY event_id DESC').all(LIMIT_EVENT)) {
    const detail = JSON.parse(row.event_detail);
    if (detail.key === key) return detail.new ?? null;
  }
  return null;
}


/**
 * The `machine_limit` events in a window, oldest first: when a limit changed, its key, and the old and new value.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{from: number, until: number}} window - epoch ms
 * @returns {{at: string, key: string, old: unknown, new: unknown}[]}
 */
export function readLimitChanges(db, { from, until }) {
  return db.prepare("SELECT event_at, event_detail FROM event WHERE event_kind = 'machine_limit' AND event_at >= ? AND event_at < ? ORDER BY event_id")
    .all(new Date(from).toISOString(), new Date(until).toISOString())
    .map(row => { const detail = JSON.parse(row.event_detail); return { at: row.event_at, key: detail.key, old: detail.old ?? null, new: detail.new ?? null }; });
}
