import { REVIEW_ROUTING_ENGINE } from './review-routing-engine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './review-independence-engine.js';
import { Refused } from './refused.js';

/** A declared vendor label is compared as text, never inferred from a model or diagnostic. */
export function familyName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/** Read policy from native snapshot metadata; damaged policy cannot silently downgrade a strict item. */
export function itemReviewPolicy(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`review_independence:${id}`);
  let policy;
  try { policy = row ? JSON.parse(row.meta_value) : { version: 1, sensitive: false, reviewFamily: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_review_family:${id}`)?.meta_value ?? null }; }
  catch { throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item'); }
  if (policy.version !== 1 || typeof policy.sensitive !== 'boolean'
    || !(policy.reviewFamily === null || typeof policy.reviewFamily === 'string' && familyName(policy.reviewFamily))) {
    throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item');
  }
  return { ...policy, tier: policy.sensitive || policy.reviewFamily ? 'strict' : 'standard' };
}



/** Modern recorded policy is an authority witness; old reviews cannot reinterpret its rules. */
export function itemReviewPolicyEngine(board, id) {
  if (!board) return 1;
  const routingEngine = routingPolicyEngine(board);
  if (routingEngine > 1) return routingEngine;
  return board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key=? OR meta_key IN ('line_setting:requireReviewFamilies','review_independence:active') LIMIT 1")
    .get(`review_independence:${id}`) ? REVIEW_INDEPENDENCE_ENGINE : 1;
}

/** A queue selector must understand every modern policy before excluding or choosing its target. */
export function anyItemReviewPolicyEngine(board) {
  const routingEngine = routingPolicyEngine(board);
  if (routingEngine > 1) return routingEngine;
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key LIKE 'review_independence:%' OR meta_key IN ('line_setting:requireReviewFamilies','review_independence:active') LIMIT 1").get()
    ? REVIEW_INDEPENDENCE_ENGINE : 1;
}


/** The first modern native prefix position activates new review rules without rewriting older receipts. */
export function recordReviewPolicyActivation(board, engine) {
  if (engine >= REVIEW_ROUTING_ENGINE) {
    board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_routing:active',?) ON CONFLICT(meta_key) DO NOTHING")
      .run(String(REVIEW_ROUTING_ENGINE));
  }
  if (engine < REVIEW_INDEPENDENCE_ENGINE) return;
  board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('review_independence:active',?) ON CONFLICT(meta_key) DO NOTHING")
    .run(String(REVIEW_INDEPENDENCE_ENGINE));
}

/** A committed routing prefix fences fresh envelopes without changing genuine old receipts. */
function routingPolicyEngine(board) {
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_routing:active'").get() ? REVIEW_ROUTING_ENGINE : 1;
}
