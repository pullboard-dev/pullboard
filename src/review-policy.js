import { classifiedStrict } from './review-tier.js';
import { reviewTierFloor } from './review-tier.js';
import { REVIEW_ROUTING_ENGINE } from './review-routing-engine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './review-independence-engine.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { FAMILY_ALIAS_ENGINE } from './family-alias-engine.js';
import { Refused } from './refused.js';

/** Index the explicit alias list once: each declared spelling, lowercased, names its canonical family [#1762]. */
export function familyIndex(families) {
  const index = new Map();
  for (const [canonical, aliases] of Object.entries(families ?? {})) {
    for (const name of [canonical, ...aliases]) index.set(name.trim().toLowerCase(), canonical.trim().toLowerCase());
  }
  return index;
}

/** The alias index applies only at or above its engine, so sealed older moves keep the comparison they were recorded under [#1762]. */
export function familyAliasesOf(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= FAMILY_ALIAS_ENGINE ? board.familyAliases ?? null : null;
}

/** A declared vendor label is compared as text, never inferred from a model or diagnostic; only the explicit alias index maps spellings to one family. */
export function familyName(value, aliases = null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const name = value.trim().toLowerCase();
  return aliases?.get(name) ?? name;
}

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
  const tierEngine = reviewTierFloor(board, id);
  if (tierEngine > 1) return tierEngine;
  const routingEngine = routingPolicyEngine(board);
  if (routingEngine > 1) return routingEngine;
  return board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key=? OR meta_key IN ('line_setting:requireReviewFamilies','review_independence:active') LIMIT 1")
    .get(`review_independence:${id}`) ? REVIEW_INDEPENDENCE_ENGINE : 1;
}

/** A queue selector must understand every modern policy before excluding or choosing its target. */
export function anyItemReviewPolicyEngine(board) {
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
