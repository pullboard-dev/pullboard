/** Name the exported functions whose JSDoc has no summary or whose @param names differ from the signature; it parses nothing [C7,#1807]. */

/**
 * The findings for a list of exported functions: one { file, name, problem } per function without a summary
 * (problem MISSING_SUMMARY, also for no JSDoc at all) and one per function whose documented @param names differ from its
 * signature's parameter names, in order (problem PARAM_MISMATCH). Why: a stale or absent summary leaves a reader
 * guessing what an export does, and the check needs one pure rule that a later step feeds from the code map [C7,#1807].
 * @param {{ file: string, name: string, params: string[], jsdoc: { summary: string, params: string[] } | null }[]} exports
 * @returns {{ file: string, name: string, problem: 'MISSING_SUMMARY' | 'PARAM_MISMATCH' }[]}
 */
export function jsdocFindings(exports) {
  const findings = [];
  for (const { file, name, params = [], jsdoc } of exports) {
    if (typeof jsdoc?.summary !== 'string' || !jsdoc.summary.trim()) {
      findings.push({ file, name, problem: 'MISSING_SUMMARY' });
      continue;
    }
    const documented = jsdoc.params ?? [];
    if (documented.length !== params.length || documented.some((documentedName, index) => documentedName !== params[index])) {
      findings.push({ file, name, problem: 'PARAM_MISMATCH' });
    }
  }
  return findings;
}
