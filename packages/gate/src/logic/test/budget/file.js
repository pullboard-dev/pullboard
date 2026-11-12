/** Runtime budget decisions keep real observations separate from audit placement [C7]. */
export const DEFAULT_TEST_FILE_BUDGET_MS = 120_000;

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

/** The most runner load may stretch a file's budget, so a file four times over still fails on any runner. */
export const MAX_LOAD_SCALE = 4;

/**
 * How many times longer a file's wall clock ran because the runner had more runnable work than cores: the mean
 * one-minute load over the file's run per core, at least 1, at most MAX_LOAD_SCALE.
 * Why: a runner runs many jobs at once, so a file that needs 100 s alone takes 170 s beside them; dividing by the
 * measured load charges each file for its own work, the same on an idle runner and a busy one (#4944).
 */
export function testFileLoadScale(loads = [], cores = 1) {
  const seen = loads.filter(load => Number.isFinite(load) && load >= 0);
  if (!seen.length || !(cores > 0)) return 1;
  const perCore = seen.reduce((sum, load) => sum + load, 0) / seen.length / cores;
  return Math.min(MAX_LOAD_SCALE, Math.max(1, perCore));
}

/** A genuine audit placement runs without enforcing the interactive gate budget; `scale` is the runner load scale. */
export function testFileBudgetFailure(file, durationMs, limit, audit = false, scale = 1) {
  if (audit) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError(`missing test file runtime for ${file}`);
  const budget = testFileLimit(limit);
  const charged = durationMs / Math.min(MAX_LOAD_SCALE, Math.max(1, Number(scale) || 1));
  const load = charged < durationMs ? ` (${Math.ceil(charged)}ms at runner load ${(durationMs / charged).toFixed(1)}x)` : '';
  return charged > budget ? `${file} took ${Math.ceil(durationMs)}ms${load}, over its ${budget}ms test file budget; split it or move it to the audit` : null;
}
