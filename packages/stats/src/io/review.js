/** Read submits, queue exits, reservations, verdict rows and item review reservations, read-only [C7,#6138]. */
import { REVIEW_FLOW_KINDS } from '../logic/review.js';

/** The ISO text of a stored time, as epoch ms, or null. */
const ms = text => { const value = Date.parse(String(text ?? '')); return Number.isFinite(value) ? value : null; };

/**
 * What the review flow needs, up to a moment.
 *
 * Why: a wait that began before the window still sits in its queue, so events are read from the start of the board;
 * only the verdicts are limited to the window, and reservations are those still live at its end (the board clears one at a verdict, so a live one belongs to an item waiting for review).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{until: number}} window - epoch ms
 * @returns {{events: object[], verdicts: object[], reservedNow: {item: number, by: string, until: string}[]}}
 */
export function readReviewFlow(db, { until }) {
  const marks = REVIEW_FLOW_KINDS.map(() => '?').join(',');
  const stop = new Date(until).toISOString();
  const events = db.prepare(`SELECT event_kind AS kind, item_id AS item, event_at AS at, event_detail AS detail FROM event
    WHERE event_kind IN (${marks}) AND event_at < ? ORDER BY event_id`).all(...REVIEW_FLOW_KINDS, stop).map(row => {
    let until_ = null;
    if (row.kind === 'reserve') { try { until_ = ms(JSON.parse(row.detail)?.until); } catch { until_ = null; } }
    return { kind: row.kind, item: row.item, at: Date.parse(row.at), ...(row.kind === 'reserve' ? { until: until_ } : {}) };
  });
  const verdicts = db.prepare(`SELECT item_id AS item, verdict_at AS at, verdict_decision AS decision, verdict_verifier_family AS family FROM verdict
    WHERE verdict_at < ? ORDER BY verdict_id`).all(stop).map(row => ({ ...row, at: Date.parse(row.at) }));
  const reservedNow = db.prepare(`SELECT item_id AS item, item_review_by AS by, item_review_until AS until FROM item
    WHERE item_review_by IS NOT NULL AND item_review_until > ? ORDER BY item_id`).all(stop);
  return { events, verdicts, reservedNow };
}
