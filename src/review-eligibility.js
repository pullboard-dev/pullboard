/** The show command and review queue use the native rules rather than an agent's lineage notes [V4,B26]. */
import { strictReviewProblem } from './review-routing.js';
import { itemAuthorProblem } from './item-authors.js';
import { itemReviewPolicy } from './review-independence.js';
import { reviewFamilyProblem } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { canTake } from './route-escalation.js';
import { requiredReviewFamilyProblem } from './required-review-family.js';
import { Refused } from './refused.js';

/** Return the first rule failing in the same order as the native review guards. */
export function eligibilityProblem(board, item, agent, { policy = 'any', familyPolicy = 'off' } = {}) {
  const identity = itemAuthorProblem(board, item, agent.agent_id);
  if (identity) return identity;
  if (!canTake(agent.agent_route ?? 'strong', item.item_route)) return new Refused('ROUTE', 'this seat route does not cover the item');
  if (policy === 'coordinator' && item.item_lane !== 'coordinator' && agent.agent_id !== 'coordinator') return new Refused('COORDINATOR_VERIFIES', 'this board has the coordinator verify lane work');
  const required = requiredReviewFamilyProblem(board, item, agent.agent_id);
  if (required) return required;
  const strict = strictReviewProblem(board, item, agent.agent_id);
  if (strict) return strict;
  const family = twoTierReviews(board) ? reviewFamilyProblem(board, item, agent.agent_id, familyPolicy)
    : familyPolicy === 'require' && (!agent.agent_family || !item.item_builder_family || agent.agent_family === item.item_builder_family)
      ? new Refused('O2_FAMILY_MATCH', 'legacy policy requires different declared families') : null;
  if (family) return family;
  if (item.item_review_by && item.item_review_by !== agent.agent_id && item.item_review_until > board.clock.now().toISOString()) return new Refused('REVIEW_HELD', `${item.item_review_by} currently holds the review`);
  return null;
}

/** Expose the tier and eligible seats, keeping each ineligible seat's explanation to its first native rule. */
export function reviewEligibility(board, item, options = {}) {
  const policy = itemReviewPolicy(board, item.item_id);
  const agents = board.db.prepare('SELECT agent_id,agent_route,agent_family FROM agent ORDER BY agent_id').all();
  const result = { tier: twoTierReviews(board) ? policy.tier : 'legacy', requiredFamily: policy.reviewFamily,
    ready: item.item_status === 'submitted' || item.item_status === 'verified' && !item.item_merged_commit,
    eligible: [], ineligible: [] };
  if (!result.ready) return result;
  for (const agent of agents) {
    const problem = eligibilityProblem(board, item, agent, options);
    if (problem) result.ineligible.push({ agent: agent.agent_id, code: problem.code, rule: problem.message });
    else result.eligible.push(agent.agent_id);
  }
  return result;
}
