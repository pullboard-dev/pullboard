import * as store from './board.js';

/**
 * Select one piece of work for the already-resolved native seat without opening another seat or
 * reserving anything. Existing claims take precedence even when their lease has expired: the
 * persisted claim still belongs to this seat and must be resumed or explicitly released first.
 * A live review held by this seat precedes new review work; otherwise eligible reviews precede
 * builds, matching the interactive next command's review-first behavior.
 *
 * @param {any} board
 * @param {{ agent_id: string, agent_lane: string }} nativeSeat - The exact seat resolved by the caller.
 * @param {{ policy?: string, familyPolicy?: string, skipIds?: number[] }} [options]
 * @returns {{ item: any | null, review: boolean, held: boolean, reasons: string[] }}
 */
export function dispatchWork(board, nativeSeat, { policy = 'any', familyPolicy = 'off', skipIds = [] } = {}) {
  const agentId = nativeSeat.agent_id;
  const lane = nativeSeat.agent_lane;

  // Match the persisted claim owner rather than lease liveness. A lease expiry does not itself
  // change a claimed item to open, and claim's ONE_CLAIM guard treats the seat as its owner.
  const claim = board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner=? ORDER BY item_id LIMIT 1").get(agentId);
  if (claim) return { item: claim, review: false, held: true, reasons: [] };

  const heldReview = store.listItems(board).find(item => item.item_status === 'submitted'
    && store.reviewHolder(board, item) === agentId);
  if (heldReview) return { item: heldReview, review: true, held: true, reasons: [] };
  const review = store.nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, skipIds });
  if (review.item) {
    return { item: review.item, review: true, held: store.reviewHolder(board, review.item) === agentId, reasons: review.reasons };
  }

  const build = store.nextFor(board, { agentId, lane });
  return { item: build.item, review: false, held: false, reasons: build.reasons };
}
