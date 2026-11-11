/** Canonical model declarations used when a worktree is created without an explicit vendor family [C7]. */

/** Known model labels are the only implicit family declarations; unfamiliar labels stay unknown. */
export const MODEL_TIERS = Object.freeze({
  'claude-haiku-6-0': Object.freeze({ family: 'anthropic', route: 'light' }),
  'claude-opus-5-5': Object.freeze({ family: 'anthropic', route: 'strong' }),
  'claude-sonnet-5-5': Object.freeze({ family: 'anthropic', route: 'strong' }),
  codex: Object.freeze({ family: 'openai', route: 'strong' }),
  'gpt-6-codex': Object.freeze({ family: 'openai', route: 'strong' }),
  'gpt-6-luna': Object.freeze({ family: 'openai', route: 'light' }),
  'gpt-6.1-sol': Object.freeze({ family: 'openai', route: 'strong' }),
  'gpt-6.1-terra': Object.freeze({ family: 'openai', route: 'strong' }),
});

/** Return the known family and route for one exact normalized model label, or null for unknown models. */
export function modelTier(model) {
  if (typeof model !== 'string') return null;
  const key = model.trim().toLowerCase().replace(/[\s_]+/gu, '-');
  return Object.hasOwn(MODEL_TIERS, key) ? MODEL_TIERS[key] : null;
}
