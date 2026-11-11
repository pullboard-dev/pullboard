/** Default-off session exit policy, with explicit finite claim budgets [B3,C7,N2]. */
export function exitRulesDefaults() { return { enabled: false, tokens: 150_000_000, calls: 2000 }; }

/** Validate recognized settings without interpreting unknown counters as zero. */
export function exitRulesConfigProblems(value) {
  return !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['enabled', 'tokens', 'calls', 'contextCeiling'].includes(key))
    || Object.hasOwn(value, 'contextCeiling') && !(Number.isSafeInteger(value.contextCeiling) && value.contextCeiling > 0)
    || typeof value.enabled !== 'boolean' || !['tokens', 'calls'].every(key => Object.hasOwn(value, key)
      && Number.isSafeInteger(value[key]) && value[key] > 0)
    ? ['"exitRules" has enabled boolean and positive whole-number tokens and calls budgets, and an optional positive whole-number contextCeiling'] : [];
}

/** Partial repository configuration retains both independently configured budget defaults. */
export function mergeExitRules(base, value) {
  return value === undefined ? base : value && typeof value === 'object' && !Array.isArray(value) ? { ...base, ...value } : value;
}
