/** The tick notes a green gate earns for [test] clauses that name a test file it ran, from its own receipt [C7,V4]. */

/** The most case names one tick note lists; the receipt keeps the rest. */
const NAMED_CASES = 5;

/**
 * One tick note per [test] clause the builder has not ticked whose named test file the gate ran green, naming the
 * cases the receipt observed passing in it. Why: submit no longer waits on a builder-run proof, so the gate records
 * the evidence itself, and a red gate records none.
 *
 * @param {object} item - The submitted item.
 * @param {object[]} thread - The item's thread, to leave builder ticks alone.
 * @param {{ gateFiles: Set<string>, outcomes: { file: string, name: string, passed: boolean, skipped: boolean }[], head: string }} run - Files the gate ran, the receipts' per-test outcomes and the head proved.
 * @param {{ clauseTicks: Function, criterionClauses: Function, gateNamedFile: Function }} state - The state cell's clause readers, passed in by the caller.
 * @returns {string[]} Note texts for `pullboard fact`.
 */
export function gateClauseTickNotes(item, thread, { gateFiles, outcomes, head }, { clauseTicks, criterionClauses, gateNamedFile }) {
  const ticks = clauseTicks(thread, item.item_owner);
  const notes = [];
  for (const clause of criterionClauses(item.item_criterion)) {
    if (ticks.has(clause.number)) continue;
    const file = gateNamedFile(clause, gateFiles, item);
    if (!file) continue;
    const passed = outcomes.filter(row => row.file === file && row.passed && !row.skipped).map(row => row.name);
    if (!passed.length || outcomes.some(row => row.file === file && !row.passed && !row.skipped)) continue;
    const listed = passed.slice(0, NAMED_CASES).join('; ');
    notes.push(`clause ${clause.number} [test]: gate run of ${file} green at ${head.slice(0, 12)}: ${passed.length} case${passed.length === 1 ? '' : 's'} passed (${listed}${passed.length > NAMED_CASES ? '; ...' : ''})`);
  }
  return notes;
}
