/** Runtime budget decisions keep real observations separate from audit placement [C7]. */
export const DEFAULT_TEST_FILE_BUDGET_MS = 600_000;

/** Validate a finite positive bound instead of silently accepting malformed limits. */
export function testFileLimit(value = DEFAULT_TEST_FILE_BUDGET_MS) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('test file budget must be a positive finite number of milliseconds');
  return value;
}

/** A candidate may tighten, but never silently increase or delete, an accepted limit. */
export function requireTestFileRatchet(file, previous, next) {
  const before = testFileLimit(previous), after = testFileLimit(next);
  if (after > before) throw new Error(`test file budget for ${file} may not increase from ${before}ms to ${after}ms`);
  return after;
}

/** A genuine audit placement runs without enforcing the interactive gate budget. */
export function testFileBudgetFailure(file, durationMs, limit, audit = false) {
  if (audit) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError(`missing test file runtime for ${file}`);
  const budget = testFileLimit(limit);
  return durationMs > budget ? `${file} took ${Math.ceil(durationMs)}ms, over its ${budget}ms test file budget; split it or move it to the audit` : null;
}
