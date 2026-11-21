/**
 * The clock line of pullboard status: the invariant "items without owner+deadline = 0", read from the one stored
 * health document (board meta key clock.health) so status never imports the clock table [B4,C7].
 */

/** Board meta key where the clock pass stores its health document (the key packages/health writes). */
const CLOCK_HEALTH_META_KEY = 'clock.health';
/** A stored document older than this is marked stale. */
const STALE_AFTER_MS = 3 * 60_000;

/** The stored clock health document, or null when no pass stored one or the stored text is not JSON. */
export function statusClock(board, readBoardMeta) {
  const text = readBoardMeta(board.db, CLOCK_HEALTH_META_KEY);
  if (text === undefined || text === null) return null;
  try {
    const document = JSON.parse(text);
    return document && typeof document === 'object' ? document : null;
  } catch {
    return null;
  }
}

/** The one status line for a stored document at `now` (ms); stale when the pass is older than 3 minutes. */
export function statusClockLine(document, now) {
  if (!document) return 'clock: no pass yet';
  const age = Math.max(0, Math.round((now - Date.parse(document.at)) / 1000));
  const stale = age * 1000 > STALE_AFTER_MS ? ' (stale)' : '';
  return `clock: items without owner+deadline ${document.withoutOwnerDeadline}; overdue ${document.overdue} (oldest ${document.oldestOverdueMinutes ?? 0} min); last pass ${age} s ago${stale}`;
}
