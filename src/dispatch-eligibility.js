import * as store from './board.js';

/**
 * Select one piece of work for the already-resolved native seat without opening another seat or
 * reserving anything. Existing live claims take precedence; expired leases are projected as open by the board
 * and may be reclaimed through the same eligibility guards as other open work.
 * A live review held by this seat precedes new review work; otherwise eligible reviews precede
 * builds, matching the interactive next command's review-first behavior.
 *
 * @param {any} board
 * @param {{ agent_id: string, agent_lane: string }} nativeSeat - The exact seat resolved by the caller.
 * @param {{ policy?: string, familyPolicy?: string, skipIds?: number[], assignedIds?: number[] }} [options]
 * @returns {{ item: any | null, review: boolean, held: boolean, reasons: string[] }}
 */
export function dispatchWork(board, nativeSeat, { policy = 'any', familyPolicy = 'off', skipIds = [], assignedIds = [] } = {}) {
  const agentId = nativeSeat.agent_id;
  const lane = nativeSeat.agent_lane;

  const claim = store.listItems(board).find(item => item.item_status === 'claimed' && item.item_owner === agentId);
  if (claim) return { item: claim, review: false, held: true, reasons: [] };

  const heldReview = store.listItems(board).find(item => item.item_status === 'submitted'
    && store.reviewHolder(board, item) === agentId);
  if (heldReview) return { item: heldReview, review: true, held: true, reasons: [] };
  const review = store.nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, skipIds, omitIds: assignedIds });
  if (review.item) {
    return { item: review.item, review: true, held: store.reviewHolder(board, review.item) === agentId, reasons: review.reasons };
  }

  const build = store.nextFor(board, { agentId, lane, omitIds: assignedIds });
  return { item: build.item, review: false, held: false, reasons: build.reasons };
}
