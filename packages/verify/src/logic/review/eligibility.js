import { reviewPatchAuthors } from '../../io/review/composition.js';
import { compositionFamilyFallback } from '../../io/review/composition.js';
import { withFamilyReads } from '../../../../items/index.js';
import { committedItemAuthors } from '../../io/review/independence.js';
import { earlierHolderProblem } from '../../io/review/independence.js';
import { strictReviewProblem as strictAuthorProblem } from '../../io/review/independence.js';
/** The show command and review queue use the native rules rather than an agent's lineage notes [V4,B26]. */
import { strictReviewProblem } from '../../io/review/routing.js';
import { itemAuthorProblem } from '../../../../items/index.js';
import { itemReviewPolicy } from '../../io/review/independence.js';
import { reviewFamilyEligibility } from '../../io/review/independence.js';
import { twoTierReviews } from '../../io/review/independence.js';
import { agentParent } from '../../../../seats/index.js';
import { canTake } from '../../../../seats/index.js';
import { itemAuthors } from '../../../../items/index.js';
import { requiredReviewFamilyProblem } from '../required.js';
import { Refused } from '../../../../kernel/index.js';

/** The required-family refusal, or null when review.relaxRequiredFamily is on and the caller holds a relaxation witness for this item and seat [C7]. */
export function requiredFamilyStands(problem, board, item, agentId, { relaxRequiredFamily = false, requiredFamilyWitness = null } = {}) {
  if (!problem) return null;
  return relaxRequiredFamily === true && requiredFamilyWitness?.(board, item, agentId) ? null : problem;
}

/**
 * Return the first rule failing in the same order as the native review guards. With review.relaxRequiredFamily on
 * (`relaxRequiredFamily`) and a relaxation witness for this item and seat (`requiredFamilyWitness`, read by the caller),
 * a --review-family item no longer refuses a seat of another family; without a witness, or with the setting off, it refuses as before [C7].
 */
export function eligibilityProblem(board, item, agent, { policy = 'any', familyPolicy = 'off', relaxRequiredFamily = false, requiredFamilyWitness = null } = {}) {
  const identity = itemAuthorProblem(board, item, agent.agent_id, { reviewPatchAuthors, committedItemAuthors, twoTierReviews, strictReviewProblem: strictAuthorProblem });
  if (identity) return identity;
  const earlier = earlierHolderProblem(board, item, agent.agent_id);
  if (earlier) return earlier;
  if (!canTake(agent.agent_route ?? 'strong', item.item_route)) return new Refused('ROUTE', 'this seat route does not cover the item');
  if (policy === 'coordinator' && item.item_lane !== 'coordinator' && agent.agent_id !== 'coordinator') return new Refused('COORDINATOR_VERIFIES', 'this board has the coordinator verify lane work');
  const required = requiredReviewFamilyProblem(board, item, agent.agent_id);
  const stands = requiredFamilyStands(required, board, item, agent.agent_id, { relaxRequiredFamily, requiredFamilyWitness });
  if (stands) return stands;
  const strict = strictReviewProblem(board, item, agent.agent_id);
  if (strict) return strict;
  const family = reviewFamilyEligibility(board, item, agent.agent_id, familyPolicy);
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
  try { const observed = { ...board, db, familyAliases: board.familyAliases }; return withFamilyReads(observed, () => work(observed)); }
  finally { board.db.exec('RELEASE review_eligibility'); }
}

/** Expose native eligibility; the strict reachability guard may skip seats whose result it discards. */
export function reviewEligibility(board, item, options = {}, { strictOnly = false } = {}) {
  return withReviewFacts(board, observed => projectEligibility(observed, item, options, strictOnly));
}

/** Apply the unchanged native eligibility guards to every candidate in the same read projection. */
function projectEligibility(board, item, options, strictOnly) {
  const policy = itemReviewPolicy(board, item.item_id);
  const result = { tier: twoTierReviews(board) ? policy.tier : 'legacy', requiredFamily: policy.reviewFamily,
    ready: item.item_status === 'submitted' || item.item_status === 'verified' && !item.item_merged_commit,
    eligible: [], ineligible: [] };
  const fallback = policy.tier === 'strict' ? compositionFamilyFallback(board, item) : null;
  if (fallback) result.owner = fallback.owner;
  if (!result.ready || strictOnly && result.tier !== 'strict') return result;
  result.authorParents = authorParents(board, item);
  const agents = board.db.prepare('SELECT agent_id,agent_route FROM agent ORDER BY agent_id').all();
  for (const agent of agents) {
    const problem = eligibilityProblem(board, item, agent, options);
    if (problem) result.ineligible.push({ agent: agent.agent_id, code: problem.code, rule: problem.message });
    else result.eligible.push(agent.agent_id);
  }
  return result;
}

/**
 * Group the item's authors by their declared parent session, so show can say once why seats under that parent are not offered
 * the review. A seat that joined without a parent groups under `unknown` and excludes no one by parent [V1,B3,C7].
 */
function authorParents(board, item) {
  const ports = { reviewPatchAuthors, committedItemAuthors, twoTierReviews };
  const groups = new Map();
  for (const author of itemAuthors(board, item, ports)) {
    const digest = agentParent(board, author), label = digest ? digest.slice(0, 12) : 'unknown';
    groups.set(label, [...groups.get(label) ?? [], author]);
  }
  return [...groups].map(([parent, seats]) => ({ parent, seats }));
}
