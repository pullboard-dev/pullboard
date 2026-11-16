/** Routine, standard and escalation tiers, each served by a self-hosted endpoint and a model [C7]. */

/** The tier names; any model or endpoint may fill them, so no vendor appears here. */
export const TIER_NAMES = ['routine', 'standard', 'escalation'];

/** True for a trimmed, nonempty string. */
const text = value => typeof value === 'string' && value.trim() !== '' && value.trim() === value;

/**
 * Every problem in a `tiers` setting: a map from routine, standard or escalation to { endpoint, model }.
 * Why: a tier with no endpoint or model would send work nowhere, so it is refused naming the tier.
 *
 * @param {unknown} tiers the `tiers` setting, undefined when unset
 * @returns {string[]}
 */
export function tiersProblems(tiers) {
  if (tiers === undefined) return [];
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return ['"tiers" maps routine, standard and escalation to { "endpoint", "model" }'];
  const problems = [];
  for (const [name, tier] of Object.entries(tiers)) {
    if (!TIER_NAMES.includes(name)) problems.push(`"tiers" has an unknown tier "${name}"; use routine, standard or escalation`);
    else if (!tier || typeof tier !== 'object' || Array.isArray(tier)) problems.push(`tier "${name}" is an object with "endpoint" and "model"`);
    else {
      for (const key of Object.keys(tier)) if (!['endpoint', 'model'].includes(key)) problems.push(`tier "${name}" has an unknown field "${key}"; use endpoint and model`);
      for (const field of ['endpoint', 'model']) if (!text(tier[field])) problems.push(`tier "${name}" is missing its ${field}`);
    }
  }
  return problems;
}
