/** Move the events of long-verified items from the hot event table into event_archive [C7]. */
import { moveEventsToArchive } from './log.js';

/** Items verified (or landed) longer ago than this have their events archived. */
export const ARCHIVE_AFTER_DAYS = 30;

/**
 * Move every event of an item verified more than 30 days before `now` into event_archive, in one transaction.
 * Events of open, claimed and recently verified items, and events that belong to no item, stay in the hot table.
 * Off unless `enabled` is exactly true (the caller passes board.archiveEvents), so the event table is untouched by default;
 * not wired to a schedule here.
 * @param {any} board - An open board.
 * @param {Date|number|string} now - The moment to measure from, so a test can pass a fake clock.
 * @param {{ enabled?: boolean }} [options] - `enabled` is the board.archiveEvents setting; it defaults to off.
 * @returns {{ moved: number }} How many event rows moved.
 */
export function archiveOldEvents(board, now, { enabled = false } = {}) {
  if (enabled !== true) return { moved: 0 };
  const at = new Date(now);
  const cutoff = new Date(at.getTime() - ARCHIVE_AFTER_DAYS * 86_400_000).toISOString();
  const itemIds = board.db.prepare(`SELECT item_id FROM item
    WHERE (item_status = 'verified' OR (item_status = 'withdrawn' AND item_merged_commit IS NOT NULL)) AND item_updated_at < ?`)
    .all(cutoff).map(row => row.item_id);
  return { moved: moveEventsToArchive(board, itemIds, at.toISOString()) };
}
