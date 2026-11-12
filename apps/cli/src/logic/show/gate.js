/** The queued-gate lines `pullboard show` prints for an item's current hand-off record [C7]. */

/**
 * Whether an infrastructure-stopped gate no longer belongs to the open or claimed item: another seat now holds it, or
 * its bar was refrozen since. Why: #3325 was refrozen and claimed by a fresh seat, yet show still printed the old stop's
 * "nothing to do as the builder", so the new holder could not tell it had a build to do.
 *
 * @param {{ state?: string, agentId?: string, digest?: string } | null} job
 * @param {{ item_status?: string, item_owner?: string | null, item_frozen_digest?: string | null }} item
 * @returns {boolean}
 */
export function supersededStop(job, item) {
  if (job?.state !== 'infrastructure' || !['claimed', 'open'].includes(item?.item_status)) return false;
  return (job.digest ?? null) !== (item.item_frozen_digest ?? null) || (item.item_status === 'claimed' && job.agentId !== item.item_owner);
}

/**
 * The queued-gate lines for show: the gate's state and source, then its refusal and next step. A superseded
 * infrastructure stop is named as an earlier seat's gate and prints no refusal or next step, so the holder reads the
 * normal builder guidance.
 *
 * @param {{ state: string, executionCommit?: string, requeuedFor?: string, error?: { code: string, message: string, next: string }, superseded?: { agentId?: string } } | null} queued
 * @param {string | null} [gateText]
 * @returns {string[]}
 */
export function queuedGateLines(queued, gateText = null) {
  if (!queued) return [];
  if (queued.superseded) {
    return [`earlier gate: ${queued.state} at ${queued.executionCommit} for ${queued.superseded.agentId ?? 'another seat'} under an older claim or bar; it does not cover this claim`];
  }
  const lines = [`queued gate: ${gateText ?? queued.state} at ${queued.executionCommit}${queued.requeuedFor ? `; requeued on the same source after ${queued.requeuedFor}` : ''}`];
  if (queued.error) lines.push(`${queued.error.code}: ${queued.error.message}\nnext: ${queued.error.next}`);
  return lines;
}
