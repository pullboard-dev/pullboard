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

/** Bounces after which an item escalates when it is not pinned to a tier [C7]. */
export const ESCALATE_AFTER_BOUNCES = 2;

/**
 * Route one item to a tier of the project's `tiers` setting and return that tier's endpoint and model.
 * An item pinned to a tier goes there; otherwise an escalation item (or one bounced twice) goes to the escalation tier and the rest to the routine tier.
 * Why: routing names tiers only, so a project whose tiers are all self-hosted endpoints routes with no vendor name anywhere.
 *
 * @param {Record<string, {endpoint: string, model: string}>|null|undefined} tiers the project's `tiers` setting
 * @param {{tier?: string, escalation?: boolean, bounces?: number}} item
 * @returns {{tier: string, endpoint: string, model: string}|null} null when the project declares no such tier
 */
export function routeByTier(tiers, item = {}) {
  if (!tiers || typeof tiers !== 'object') return null;
  const wanted = typeof item.tier === 'string' ? item.tier
    : item.escalation === true || (item.bounces ?? 0) >= ESCALATE_AFTER_BOUNCES ? 'escalation' : 'routine';
  const entry = Object.hasOwn(tiers, wanted) ? tiers[wanted] : null;
  return entry ? { tier: wanted, endpoint: entry.endpoint, model: entry.model } : null;
}
