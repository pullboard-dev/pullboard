import { ENGINE_VERSION } from '../../../../state/light.js';
import { SAME_FAMILY_REFUSAL_ENGINE } from '../../../../state/light.js';
import { STRICT_COMPOSITION_ENGINE } from '../../../../state/light.js';
import { classifiedStrict } from '../../io/review/tier.js';
import { reviewTierFloor } from '../../io/review/tier.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../state/light.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../state/light.js';
import { Refused } from '../../../../kernel/light.js';

import { familyName } from '../../../../items/browser.js';
export { familyIndex, aliasEngineOn, familyAliasesOf, familiesDiffer, familyName } from '../../../../items/browser.js';

/** Read policy from native snapshot metadata; damaged policy cannot silently downgrade a strict item. */
export function itemReviewPolicy(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`review_independence:${id}`);
  let policy;
  try { policy = row ? JSON.parse(row.meta_value) : { version: 1, sensitive: false, reviewFamily: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_review_family:${id}`)?.meta_value ?? null }; }
  catch { throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item'); }
  if (policy.version !== 1 || typeof policy.sensitive !== 'boolean'
    || policy.reviewTier !== undefined && policy.reviewTier !== 'strict'
    || !(policy.reviewFamily === null || typeof policy.reviewFamily === 'string' && familyName(policy.reviewFamily))) {
    throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item');
  }
  return { ...policy, tier: policy.sensitive || policy.reviewFamily || policy.reviewTier === 'strict' || classifiedStrict(board, id) ? 'strict' : 'standard' };
}


/** Modern recorded policy is an authority witness; old reviews cannot reinterpret its rules. */
export function itemReviewPolicyEngine(board, id) {
  if (!board) return 1;
  if (board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_composition:active'").get()) return Math.max(STRICT_COMPOSITION_ENGINE, reviewTierFloor(board, id));
  const tierEngine = reviewTierFloor(board, id);
  if (tierEngine > 1) return tierEngine;
  const routingEngine = routingPolicyEngine(board);
  if (routingEngine > 1) return routingEngine;
  return board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key=? OR meta_key IN ('line_setting:requireReviewFamilies','review_independence:active') LIMIT 1")
    .get(`review_independence:${id}`) ? REVIEW_INDEPENDENCE_ENGINE : 1;
}

/** A queue selector must understand every modern policy before excluding or choosing its target. */
export function anyItemReviewPolicyEngine(board) {
  if (board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_composition:active'").get()) return Math.max(STRICT_COMPOSITION_ENGINE, reviewTierFloor(board));
  const tierEngine = reviewTierFloor(board);
  if (tierEngine > 1) return tierEngine;
  const routingEngine = routingPolicyEngine(board);
  if (routingEngine > 1) return routingEngine;
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key LIKE 'review_independence:%' OR meta_key IN ('line_setting:requireReviewFamilies','review_independence:active') LIMIT 1").get()
    ? REVIEW_INDEPENDENCE_ENGINE : 1;
}


/** A committed routing prefix fences fresh envelopes without changing genuine old receipts. */
function routingPolicyEngine(board) {
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_routing:active'").get() ? REVIEW_ROUTING_ENGINE : 1;
}

/** Keep historical refusal codes for recorded moves while identifying current same-vendor conflicts. */
export function sameFamilyProblem(board, message, next) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SAME_FAMILY_REFUSAL_ENGINE) return new Refused('SAME_FAMILY', message, next);
  return new Refused('O2_FAMILY_MATCH', message, next);
}
