import {
  overdueReview,
  reviewRoutingEnabled,
} from './review-routing.js';
/** Capacity adapters retain the board's canonical review eligibility checks [N2,B13,H16]. */
import { Refused } from './refused.js';
import { ROUTES } from './route-escalation.js';
import {
  listItems,
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
export function reviewOffer(board, { agentId, lane, policy = 'any', familyPolicy = 'off', ratio = 3, runnable = false, routes = ROUTES, skipIds = [], priority = [] }, nextFor) {
  const offered = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, runnable, routes, skipIds, priority });
  const queue = reviewQueue(board);
  const held = offered.item && reviewHolder(board, offered.item) === agentId;
  if (reviewRoutingEnabled(board) && held) return { item: offered.item, queue, ratio, urgent: 'held-review', held: true };
  if (!held && reviewRoutingEnabled(board) && offered.item && priority.includes(offered.item.item_id)) return { item: offered.item, queue, ratio, urgent: 'main-red' };
  const urgent = held ? { item: null } : nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, runnable, routes, priority,
    skipIds: [...skipIds, ...listItems(board).filter(item => !overdueReview(board, item)).map(item => item.item_id)] });
  if (urgent.item) return { item: urgent.item, queue, ratio, urgent: 'age' };
  const settings = capacitySettings(board);
  const capacity = settings.reviewsFirst === true ? lineCapacitySnapshot(board) : null;
  if (capacity) ratio = typeof settings.wipPerReviewer === 'number' ? settings.wipPerReviewer : 3;
  if (capacity ? queue.pending <= lineWipLimit(ratio, capacity.activeReviewers) : queue.pending < ratio * Math.max(queue.reviewing, 1)) return null;
  const { item } = offered;
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
