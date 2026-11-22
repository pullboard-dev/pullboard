/** Review reservations held as jobs-cell leases through the board's `reviewLease` engine port [C7,V15]. */
import { getItem } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";
import { setItem } from "../../board.js";
import { Refused } from "../../../../../kernel/index.js";
import { CLEAR_REVIEW_RESERVATION_ENGINE } from "../../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { RELEASE_REASONS_ENGINE } from "../../../../../state/index.js";
import { BOARD_RELEASE_CODES_ENGINE } from "../../../../../state/index.js";

/**
 * Clear every review reservation whose jobs-cell lease lapsed: the reviewer sent no heartbeat and no renewal for the
 * lease window. The item is offered again and the release is recorded like the idle-review sweep records one.
 *
 * Why here: reserve and next --verify run it in their write, so no sweeper process is needed.
 *
 * @param {any} board
 * @param {Map<string, string | null> | null} heartbeats - Seat id to last heartbeat, read before the write opened.
 * @returns {number[]} The items whose reservation was cleared.
 */
export function sweepLapsedReviews(board, heartbeats) {
  const leases = board.enginePorts?.reviewLease;
  if (!leases) return [];
  const nowMs = board.clock.now().getTime();
  /** A reviewer's last heartbeat in epoch milliseconds, or null when the snapshot has none. */
  const seen = reviewer => { const at = heartbeats?.get(reviewer); return at ? Date.parse(at) : null; };
  const cleared = [];
  const submitted = item => getItem(board, item)?.item_status === 'submitted';
  for (const lapse of leases.reclaimLapsedReviews(board.db, { now: nowMs, seen, submitted })) {
    const item = getItem(board, lapse.item);
    if (item?.item_status !== 'submitted' || item.item_review_by !== lapse.reviewer || !(Date.parse(item.item_review_until ?? '') > nowMs)) continue;
    const reason = `Review silent for ${Math.round((nowMs - (seen(lapse.reviewer) ?? nowMs - lapse.lapsedMs)) / 60_000)} minutes; its reservation lease lapsed.`;
    setItem(board, lapse.item, { item_review_by: null, item_review_until: null });
    logEvent(board, 'coordinator', 'release', lapse.item, { review: true, reason,
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_REASONS_ENGINE ? { reasonCode: (board.executionEngineVersion ?? ENGINE_VERSION) >= BOARD_RELEASE_CODES_ENGINE ? 'REVIEW_LEASE_LAPSED' : 'OTHER' } : {}),
      lapsed: { reviewer: lapse.reviewer, lapsedMs: lapse.lapsedMs } });
    cleared.push(lapse.item);
  }
  return cleared;
}

/**
 * Hold the jobs-cell lease for a reservation the board just recorded: renew the reviewer's own lease, or take it. A
 * lease another reviewer still holds is ended first, because the board's reviewer checks already allowed this one.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @returns {void}
 */
export function holdReviewLease(board, id, agentId) {
  const leases = board.enginePorts?.reviewLease;
  if (!leases) return;
  const now = board.clock.now().getTime();
  if (leases.renewReview(board.db, id, agentId, { now })) return;
  if (leases.reserveReview(board.db, id, agentId, { now }).reserved) return;
  leases.releaseReview(board.db, id, { now });
  leases.reserveReview(board.db, id, agentId, { now });
}

/**
 * End an item's review job inside the verdict, withdraw or reopen write (SM5).
 * Why a plain row read: getItem refuses ITEM_MOVED, which no verdict declares. A replayed move may carry the item id as numeric text; the job id wants the item's integer.
 */
export function endReviewLease(board, id) {
  board.enginePorts?.reviewLease?.releaseReview(board.db, board.db.prepare('SELECT item_id FROM item WHERE item_id=?').get(id)?.item_id ?? id, { now: board.clock.now().getTime() });
}

/**
 * Clear a held review reservation on a submitted item through the coordinator transaction: the item stays submitted, its
 * review columns go null and its review-job lease ends through endReviewLease, so another reviewer can reserve it [C7,#12649].
 * Why a separate move: clearReservation clears build-route reservation columns only, so it never touched this one.
 * The event records the holder and deadline it removed, so every replica replays the same board.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string }} who - The coordinator.
 * @returns {{ holder: string, until: string | null }}
 */
export function clearReviewReservation(board, id, { agentId }) {
  coordinatorOnly(agentId, 'clears a review reservation');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < CLEAR_REVIEW_RESERVATION_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'clearing a review reservation requires replay-aware writers; upgrade every linked device');
  }
  return atomic(board, () => {
    const item = getItem(board, id);
    if (item.item_status !== 'submitted') throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted; only a submitted item holds a review reservation`);
    const holder = item.item_review_by;
    if (!holder) throw new Refused('USAGE', `item #${id} holds no review reservation, so there is nothing to clear; see pullboard show ${id}`);
    const until = item.item_review_until ?? null;
    setItem(board, id, { item_review_by: null, item_review_until: null });
    endReviewLease(board, id);
    logEvent(board, agentId, 'clear_review_reservation', id, { holder, until });
    return { holder, until };
  });
}
