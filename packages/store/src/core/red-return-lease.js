/** A red queued gate's return protects its builder's claim from idle maintenance while the lease lasts [V4,H16,B4]. */

/**
 * Whether this claim came back from a red queued gate and its lease (the fresh one, or the builder's renewal of it)
 * is still live, with no new queued submission or other hand-over since.
 * Why: the red return is the board's move, not the builder's work, so idle maintenance released the claim at about
 * 40 minutes, long before the lease the builder was promised (#2454). The lease alone decides when it opens.
 *
 * @param {any} board
 * @param {any} item
 * @param {number} at milliseconds of the observation
 * @returns {boolean}
 */
export function redReturnLeaseHolds(board, item, at) {
  if (item?.item_status !== 'claimed' || !item.item_owner || !(at < Date.parse(item.item_lease_until))) return false;
  const returned = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_by=? AND event_kind='submit_handoff_returned' ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id, item.item_owner);
  if (!returned) return false;
  const since = board.db.prepare(`SELECT 1 FROM event WHERE item_id=? AND event_id>? AND (event_kind IN ('release','submit','reopen','withdraw','merged','accept','reject','refreeze')
    OR event_kind='submit-handoff' AND json_extract(event_detail,'$.state')<>'red') LIMIT 1`).get(item.item_id, returned.event_id);
  return !since;
}
