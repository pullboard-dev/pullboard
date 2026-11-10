/** Read landings from the board's accept and merged events and step spans from the machine's span files, read-only [C7]. */
import { landingHealthSummary } from '../logic/health.js';
import { readLandingSpans } from '../../../resources/index.js';

/**
 * The landing health report for one window: every merged event in it with the item's accept before it, and every
 * landing step span that ended in it.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board, read only.
 * @param {{ commonDir: string, since: number, now: number }} window
 * @returns {ReturnType<typeof landingHealthSummary>}
 */
export function landingHealthReport(db, { commonDir, since, now }) {
  const merged = db.prepare("SELECT event_id, item_id, event_at, event_detail FROM event WHERE event_kind = 'merged' AND event_at >= ? AND item_id IS NOT NULL ORDER BY event_id")
    .all(new Date(since).toISOString());
  const accept = db.prepare("SELECT event_at FROM event WHERE item_id = ? AND event_kind = 'accept' AND event_id < ? ORDER BY event_id DESC LIMIT 1");
  const landings = merged.map(row => {
    let detail = {};
    try { detail = JSON.parse(row.event_detail); } catch { /* an unreadable detail is an ordinary landing */ }
    const accepted = accept.get(row.item_id, row.event_id);
    return { item: row.item_id, acceptAt: accepted ? Date.parse(accepted.event_at) : NaN, mergedAt: Date.parse(row.event_at), forced: detail?.forced === true };
  });
  return landingHealthSummary({ landings, spans: readLandingSpans(commonDir, { since, now }), since, now });
}
