/** How long a returned rejection waits for its builder before it is offered again [C7,#11093]. */
export const REOFFER_AFTER_MS = 20 * 60_000;

/**
 * Whether a returned rejection has gone unclaimed long enough to be offered again.
 *
 * Why pure: the caller passes the time the rejection came back and the current time, so no clock or board is read here.
 *
 * @param {string | number | Date | null | undefined} returnedAt - When the rejection went back to open; missing is never due.
 * @param {number} now - The current time in milliseconds.
 * @returns {boolean} True from exactly 20 minutes on.
 */
export function reofferDue(returnedAt, now) {
  if (returnedAt === null || returnedAt === undefined || returnedAt === '') return false;
  const at = returnedAt instanceof Date ? returnedAt.getTime() : typeof returnedAt === 'number' ? returnedAt : Date.parse(returnedAt);
  if (!Number.isFinite(at)) return false;
  return now - at >= REOFFER_AFTER_MS;
}
