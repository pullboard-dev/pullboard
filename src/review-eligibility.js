import { committedItemAuthors } from './review-independence.js';
import { strictReviewProblem as strictAuthorProblem } from './review-independence.js';
/** The show command and review queue use the native rules rather than an agent's lineage notes [V4,B26]. */
import { strictReviewProblem } from './review-routing.js';
import { itemAuthorProblem } from './item-authors.js';
import { itemReviewPolicy } from './review-independence.js';
import { reviewFamilyProblem } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
import { canTake } from './route-escalation.js';
import { requiredReviewFamilyProblem } from './required-review-family.js';
import { familyName } from './review-policy.js';
import { familyAliasesOf } from './review-policy.js';
import { Refused } from './refused.js';

/** Return the first rule failing in the same order as the native review guards. */
export function eligibilityProblem(board, item, agent, { policy = 'any', familyPolicy = 'off' } = {}) {
  const identity = itemAuthorProblem(board, item, agent.agent_id, { committedItemAuthors, twoTierReviews, strictReviewProblem: strictAuthorProblem });
  if (identity) return identity;
  if (!canTake(agent.agent_route ?? 'strong', item.item_route)) return new Refused('ROUTE', 'this seat route does not cover the item');
  if (policy === 'coordinator' && item.item_lane !== 'coordinator' && agent.agent_id !== 'coordinator') return new Refused('COORDINATOR_VERIFIES', 'this board has the coordinator verify lane work');
  const required = requiredReviewFamilyProblem(board, item, agent.agent_id);
  if (required) return required;
  const strict = strictReviewProblem(board, item, agent.agent_id);
  if (strict) return strict;
  const family = twoTierReviews(board) ? reviewFamilyProblem(board, item, agent.agent_id, familyPolicy)
    : familyPolicy === 'require' && (!agent.agent_family || !item.item_builder_family
      || familyName(agent.agent_family, familyAliasesOf(board)) === familyName(item.item_builder_family, familyAliasesOf(board)))
      ? new Refused('O2_FAMILY_MATCH', 'legacy policy requires different declared families') : null;
  if (family) return family;
  if (item.item_review_by && item.item_review_by !== agent.agent_id && item.item_review_until > board.clock.now().toISOString()) return new Refused('REVIEW_HELD', `${item.item_review_by} currently holds the review`);
  return null;
}

/** Reuse identical SELECT results for one synchronous projection, never across calls or native moves. */
function withReviewFacts(board, work) {
  const statements = new Map();
  const db = {
    /** Prepare each read once and retain its exact native results inside the SQLite snapshot. */
    prepare(sql) {
      if (statements.has(sql)) return statements.get(sql);
      if (!/^\s*SELECT\b/iu.test(sql)) throw new Error('review eligibility facts accept SELECT statements only');
      const statement = board.db.prepare(sql);
      const results = new Map();
      /** A shared item fact is read once; distinct candidate parameters retain distinct results. */
      function read(method, args) {
        const key = JSON.stringify([method, args]);
        if (!results.has(key)) results.set(key, statement[method](...args));
        return results.get(key);
      }
      const query = {
        /** Preserve the native single-row result, including an absent row. */
        get(...args) { return read('get', args); },
        /** Preserve every native row in its original order. */
        all(...args) { return read('all', args); },
      };
      statements.set(sql, query);
      return query;
    },
  };
  // A read-only savepoint also keeps peer writes from mixing different snapshots inside one result.
  board.db.exec('SAVEPOINT review_eligibility');
  // The spread copies only enumerable properties, so the explicit alias index is carried across the snapshot [#1762].
  try { return work({ ...board, db, familyAliases: board.familyAliases }); }
  finally { board.db.exec('RELEASE review_eligibility'); }
}

/** Expose the tier and eligible seats, keeping each ineligible seat's explanation to its first native rule. */
export function reviewEligibility(board, item, options = {}) {
  return withReviewFacts(board, observed => projectEligibility(observed, item, options));
}

/** Apply the unchanged native eligibility guards to every candidate in the same read projection. */
function projectEligibility(board, item, options) {
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
