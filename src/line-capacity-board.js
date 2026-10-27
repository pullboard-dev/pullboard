/** Capacity adapters retain the board's canonical review eligibility checks [N2,B13,H16]. */
import { Refused } from './refused.js';
import { ROUTES } from './route-escalation.js';
import {
  reviewQueue,
  reviewHolder,
} from './board-query.js';
import {
  capacitySettings,
  lineCapacitySnapshot,
  lineCapacityProblem,
} from './line-capacity.js';
import { lineWipLimit } from './line-wip-limit.js';

/** Offer the existing eligible review with either the historical ratio or enabled total-cap threshold. */
export function reviewOffer(board, { agentId, lane, policy = 'any', familyPolicy = 'off', ratio = 3, runnable = false, routes = ROUTES, omitIds = [] }, nextFor) {
  const queue = reviewQueue(board);
  const settings = capacitySettings(board);
  const capacity = settings.reviewsFirst === true ? lineCapacitySnapshot(board) : null;
  if (capacity) ratio = typeof settings.wipPerReviewer === 'number' ? settings.wipPerReviewer : 3;
  if (capacity ? queue.pending <= lineWipLimit(ratio, capacity.activeReviewers) : queue.pending < ratio * Math.max(queue.reviewing, 1)) return null;
  const { item } = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, runnable, routes, omitIds });
  return item ? { item, queue, ratio } : null;
}

/** Pass only the board's renewal fact and canonical eligibility callbacks into the capacity guard. */
export function claimProblem(board, renewal, who, checks) {
  return lineCapacityProblem(board, { renewal, oldestReview: pending => oldestCapacityReview(board, pending, who, checks) });
}

/** Find the oldest eligible submission with exactly the reservation guards, including cooldown and ownership. */
function oldestCapacityReview(board, pending, who, { reviewerChecks, reviewReleaseCooldown }) {
  try {
    const checks = Object.values(reviewerChecks(board, who));
    return pending.find(item => !reviewHolder(board, item) && !reviewReleaseCooldown(board, item.item_id, who.agentId)
      && checks.every(check => !check(item))) ?? null;
  } catch (error) {
    if (error instanceof Refused) return null; // Eligibility failures are not a different claim refusal.
    throw error;
  }
}
