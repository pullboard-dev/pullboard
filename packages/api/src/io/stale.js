/** Ending an item's stale gate jobs: older candidates' open jobs on a new offer, and every open job of an item that landed [C7,#8816]. */
import { endJobs } from './jobs.js';

/**
 * End the item's open gate jobs other than the one for `keep`, when `enabled` (gate.endStaleJobs, off by default).
 * With no `keep` every open gate job of the item ends: the item landed, so no candidate of it can land again.
 * Why: a resubmitted or landed item's older gate jobs still held runner time (#8743, #8736 stayed offered after landing).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, keep?: string | null, enabled?: boolean, reason?: string, now?: number }} fields
 * @returns {string[]} The jobs ended now.
 */
export function endStaleGateJobs(db, { item, keep = null, enabled = false, reason = keep ? 'a newer gate candidate was offered for the item' : 'the item landed', now = Date.now() }) {
  if (enabled !== true) return [];
  const open = db.prepare("SELECT job_id FROM job WHERE job_kind = 'gate' AND job_item = ? AND job_step <> 'done' AND (? IS NULL OR job_candidate <> ?)").all(item, keep, keep);
  return endJobs(db, open.map(row => row.job_id), { reason, now });
}
