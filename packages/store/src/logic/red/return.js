/** A red queued gate's return protects its builder's claim from idle maintenance while the lease lasts [V4,H16,B4]. */
import { ENGINE_VERSION } from "../../../../state/light.js";
import { PINNED_CLAIM_LAPSE_ENGINE } from "../../../../state/light.js";
import { PINNED_CLAIM_RELEASE_MS } from "../pinned.js";
import { itemPinned } from "../pinned.js";
import { handoffRecord } from "../../io/submit/handoff/records.js";

/** The idle limit for an unpinned claim, counted from the red return (#2640); kept beside the health reader's copy. */
const RED_RETURN_IDLE_MS = 40 * 60_000;

/**
 * Whether this claim came back from a red queued gate and its lease (the fresh one, or the builder's renewal of it)
 * is still live, with no new queued submission or other hand-over since.
 * The hold also ends once the builder has had the idle limit (30 minutes when pinned, else 40) since the return: the
 * idle clock starts at the return, so a builder who stopped cannot keep the claim for the whole lease (#2640).
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
  const returned = board.db.prepare(`SELECT returned_event.event_id,returned_event.event_at FROM event AS returned_event WHERE returned_event.item_id=? AND (
    returned_event.event_kind='submit_handoff_returned' AND returned_event.event_by=?
    OR returned_event.event_kind='reject' AND (SELECT submitted.event_by FROM event AS submitted
      WHERE submitted.item_id=returned_event.item_id AND submitted.event_kind='submit' AND submitted.event_id<returned_event.event_id
        AND json_extract(submitted.event_detail,'$.commit')=json_extract(returned_event.event_detail,'$.commit')
      ORDER BY submitted.event_id DESC LIMIT 1)=?
    ) ORDER BY returned_event.event_id DESC LIMIT 1`)
    .get(item.item_id, item.item_owner, item.item_owner);
  if (!returned) return false;
  const pinned = (board.executionEngineVersion ?? ENGINE_VERSION) >= PINNED_CLAIM_LAPSE_ENGINE && itemPinned(board, item.item_id);
  const returnedAt = Date.parse(returned.event_at);
  if (Number.isFinite(returnedAt) && at - returnedAt >= (pinned ? PINNED_CLAIM_RELEASE_MS : RED_RETURN_IDLE_MS)) return false;
  const since = board.db.prepare(`SELECT 1 FROM event WHERE item_id=? AND event_id>? AND (event_kind IN ('release','submit','reopen','withdraw','merged','accept','reject','refreeze')
    OR event_kind='submit-handoff' AND json_extract(event_detail,'$.state')<>'red') LIMIT 1`).get(item.item_id, returned.event_id);
  return !since;
}

/**
 * Whether the claim's own queued submit is waiting for or running its gate. That wait is the holder's activity: the
 * lapsed-lease sweep and the idle release took #2504, #2341 and #2507 while their gates ran (#2561).
 */
export function submitGateInFlight(board, item) {
  if (item?.item_status !== 'claimed' || !item.item_owner) return false;
  // The record lives on the item's gate job, the one place hand-off state is kept [C7].
  const job = handoffRecord(board.db, item.item_id);
  return ['queued', 'running'].includes(job?.state) && job.agentId === item.item_owner;
}
