import tiers from './tiers.json' with { type: 'json' };

/** Canonical model declarations used when a worktree is created without an explicit vendor family [C7]. */

/** Known model labels (tiers.json, so the core names none itself) are the only implicit family declarations; unfamiliar labels stay unknown [P5]. */
export const MODEL_TIERS = Object.freeze(Object.fromEntries(Object.entries(tiers).map(([label, tier]) => [label, Object.freeze({ ...tier })])));

/** Return the known family and route for one exact normalized model label, or null for unknown models. */
export function modelTier(model) {
  if (typeof model !== 'string') return null;
  const key = model.trim().toLowerCase().replace(/[\s_]+/gu, '-');
  return Object.hasOwn(MODEL_TIERS, key) ? MODEL_TIERS[key] : null;
}
