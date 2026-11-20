/** The compatibility page's cells: conformance rows turned into one cell per setup and stage, each carrying its run id [C7]. */

/** The pipeline stages in page order; the gate's CONFORMANCE_STAGES holds the same list and a test keeps the two equal. */
export const COMPAT_STAGES = Object.freeze(['claim', 'submit', 'gate', 'review', 'accept', 'land']);

/** The outcome words a cell may carry. */
export const COMPAT_OUTCOMES = Object.freeze(['works', 'partial', 'breaks', 'unavailable', 'unknown']);

/** Recorded run words mapped to the cell outcome; any other word reads unknown. */
const OUTCOME_OF = Object.freeze({
  works: 'works', pass: 'works', green: 'works',
  partial: 'partial',
  breaks: 'breaks', fail: 'breaks', red: 'breaks',
  unavailable: 'unavailable',
});

/**
 * Group conformance rows into page cells by stage.
 * Why: the page shows what each setup does at each stage and which run said so; cells carry outcome keys and run ids, never display text.
 *
 * @param {{ language: string, stage: string, outcome: string, run: string | null }[]} rows
 * @returns {{ stage: string, cells: { language: string, outcome: string, run: string | null }[] }[]}
 */
export function compatCells(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return COMPAT_STAGES.map((stage) => ({
    stage,
    cells: list
      .filter((row) => row.stage === stage)
      .map((row) => ({
        language: row.language,
        outcome: Object.hasOwn(OUTCOME_OF, row.outcome) ? OUTCOME_OF[row.outcome] : 'unknown',
        run: row.run ?? null,
      })),
  }));
}
