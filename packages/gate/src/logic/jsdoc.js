/** Name the exported functions whose JSDoc has no summary or documents a @param name the signature lacks; it parses nothing [C7,#1807]. */

/**
 * The findings for a list of exported functions: one { file, name, problem } per function without a summary
 * (problem MISSING_SUMMARY, also for no JSDoc at all) and one per function whose JSDoc documents a top-level @param name
 * its signature lacks, in order (problem PARAM_MISMATCH). A dotted name (opts.x) reads as its top-level name (opts), and a
 * destructured signature position (name null) excuses one unmatched documented name. A summary with no @param tags is
 * house style, never a mismatch. Why: a stale name misleads a reader, while an undocumented or destructured parameter
 * costs nothing, and 4,663 of 4,680 findings on main were exactly that noise [C7,#1807,#11428].
 * @param {{ file: string, name: string, params: (string | null)[], jsdoc: { summary: string, params: string[] } | null }[]} exports
 * @returns {{ file: string, name: string, problem: 'MISSING_SUMMARY' | 'PARAM_MISMATCH' }[]}
 */
export function jsdocFindings(exports) {
  const findings = [];
  for (const { file, name, params = [], jsdoc } of exports) {
    if (typeof jsdoc?.summary !== 'string' || !jsdoc.summary.trim()) {
      findings.push({ file, name, problem: 'MISSING_SUMMARY' });
      continue;
    }
    const signature = new Set(params.filter(param => param !== null));
    const destructured = params.filter(param => param === null).length;
    const stale = new Set((jsdoc.params ?? []).map(documented => documented.split('.')[0]).filter(documented => !signature.has(documented)));
    if (stale.size > destructured) findings.push({ file, name, problem: 'PARAM_MISMATCH' });
  }
  return findings;
}
