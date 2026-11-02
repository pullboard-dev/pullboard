/** A red queued gate's fresh lease protects its builder's claim from idle maintenance until it ends [V4,H16,B4]. */

/**
 * Whether this claim is still inside the fresh lease a red queued gate gave back to its builder.
 * Why: the red return is the board's move, not the builder's work, so idle maintenance released the claim at about
 * 40 minutes, long before the lease the builder was promised (#2454). Any renewal changes the lease and ends this.
 *
 * @param {any} board
 * @param {any} item
 * @param {number} at milliseconds of the observation
 * @returns {boolean}
 */
export function redReturnLeaseHolds(board, item, at) {
  if (item?.item_status !== 'claimed' || !item.item_owner || !item.item_lease_until) return false;
  const returned = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='submit_handoff_returned' ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id, item.item_owner);
  if (!returned) return false;
  const leaseUntil = JSON.parse(returned.event_detail)?.leaseUntil;
  return leaseUntil === item.item_lease_until && at < Date.parse(leaseUntil);
}
