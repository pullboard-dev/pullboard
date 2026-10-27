import { Refused } from './refused.js';

/** A declared vendor label is compared as text, never inferred from a model or diagnostic. */
export function familyName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/** Read policy from native snapshot metadata; damaged policy cannot silently downgrade a strict item. */
export function itemReviewPolicy(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`review_independence:${id}`);
  let policy;
  try { policy = row ? JSON.parse(row.meta_value) : { version: 1, sensitive: false, reviewFamily: null }; }
  catch { throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item'); }
  if (policy.version !== 1 || typeof policy.sensitive !== 'boolean'
    || !(policy.reviewFamily === null || typeof policy.reviewFamily === 'string' && familyName(policy.reviewFamily))) {
    throw new Refused('BAD_REVIEW_POLICY', 'restore the native review policy before reviewing this item');
  }
  return { ...policy, tier: policy.sensitive || policy.reviewFamily ? 'strict' : 'standard' };
}

