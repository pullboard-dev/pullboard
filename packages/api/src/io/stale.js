/** Ending an item's stale gate jobs: older candidates' open jobs on a new offer, and every open job of an item that landed [C7,#8816]. */
import { endJobs } from './jobs.js';
import { SHARD_JOB_KIND } from './jobs.js';

/**
 * End the item's open gate jobs, and the gate-shard jobs of its proof, other than the one for `keep`, when `enabled` (gate.endStaleJobs, off by default).
 * With no `keep` every open gate job of the item ends: the item landed, so no candidate of it can land again.
 * Why: a resubmitted or landed item's older gate jobs still held runner time (#8743, #8736 stayed offered after landing), and so did their open shards (#11817).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, keep?: string | null, enabled?: boolean, reason?: string, now?: number }} fields
 * @returns {string[]} The jobs ended now.
 */
export function endStaleGateJobs(db, { item, keep = null, enabled = false, reason = keep ? 'a newer gate candidate was offered for the item' : 'the item landed', now = Date.now() }) {
  if (enabled !== true) return [];
  const open = db.prepare("SELECT job_id FROM job WHERE job_kind IN ('gate', ?) AND job_item = ? AND job_step <> 'done' AND (? IS NULL OR job_candidate <> ?)").all(SHARD_JOB_KIND, item, keep, keep);
  return endJobs(db, open.map(row => row.job_id), { reason, now });
}
