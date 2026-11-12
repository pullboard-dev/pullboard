/** The verdict tier 1 alone would give, kept beside the real verdict and never changing it [V4]. */

/**
 * Work out the verdict tier 1 alone (V4) would give for one gate run: static checks on the changed files, the item's
 * check, and the tests its change can reach, plus cells only when the change touches cell structure. A red run whose
 * failures name no committed test is a static or check failure, which tier 1 runs, so it stays red. A failing test
 * counts only when the change can reach it. The real verdict is passed in so the record shows when the two differ;
 * this function never returns or alters it.
 *
 * @param {{ real: boolean, failures?: {file: string, name: string}[], reachable?: string[] | null, cellStructure?: boolean }} input
 *   `reachable` is the list of test files the change reaches, or null when the reach is unknown.
 * @returns {{ version: 1, tier: 1, verdict: 'green' | 'red', real: 'green' | 'red', differs: boolean, reasons: string[] }}
 */
export function tier1Shadow({ real, failures = [], reachable = null, cellStructure = false } = {}) {
  const reasons = [];
  if (!real) {
    if (!failures.length) reasons.push('static-or-check');
    for (const failure of failures) {
      const reach = reachable === null || reachable.includes(failure.file);
      const cell = /^test\/cells?\//u.test(failure.file) || /(?:^|\/)cells?[-.]/u.test(failure.file);
      if (cell ? cellStructure : reach) reasons.push(`test:${failure.file}`);
    }
  }
  const verdict = reasons.length ? 'red' : 'green';
  const word = real ? 'green' : 'red';
  return { version: 1, tier: 1, verdict, real: word, differs: verdict !== word, reasons: [...new Set(reasons)].sort().slice(0, 50) };
}

/**
 * Check a recorded shadow fact and return it in one fixed key order, or null when it is malformed or contradicts itself.
 *
 * @param {any} value
 * @param {boolean} green the receipt's own real verdict
 */
export function tier1ShadowFields(value, green) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'differs,real,reasons,tier,verdict,version'
    || value.version !== 1 || value.tier !== 1 || !['green', 'red'].includes(value.verdict) || value.real !== (green ? 'green' : 'red')
    || value.differs !== (value.verdict !== value.real) || !Array.isArray(value.reasons) || value.reasons.length > 50
    || value.reasons.some(reason => typeof reason !== 'string' || !reason || reason.length > 4200 || /[\r\n\0]/u.test(reason))
    || (value.verdict === 'red') !== (value.reasons.length > 0)) return null;
  return { version: 1, tier: 1, verdict: value.verdict, real: value.real, differs: value.differs, reasons: [...value.reasons] };
}
