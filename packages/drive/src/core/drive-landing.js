/** Pure naming and summary for the landing-run jobs `pullboard land` drives through the drive cell [C7]. */

/** The job kind of one `pullboard land` run, kept apart from the finish-sequence 'landing' rows of packages/land. */
export const LANDING_RUN_KIND = 'landing-run';

/**
 * The job id of one landing run.
 *
 * @param {string} run - A fresh run id.
 * @returns {string}
 */
export function landingRunJobId(run) {
  return `land:run:${run}`;
}

/**
 * The `finished` step's payload: the batch a run wrote and what it landed, never the whole engine result.
 *
 * @param {{ batch?: { id?: string, state?: string } | null, landed?: { id: number }[], deferredUntil?: string } | undefined} result
 * @returns {{ batch: string | null, state: string | null, landed: number[], deferredUntil: string | null }}
 */
export function landingRunSummary(result) {
  return {
    batch: result?.batch?.id ?? null,
    state: result?.batch?.state ?? null,
    landed: (result?.landed ?? []).map(entry => (typeof entry === 'object' ? entry?.id : entry)).filter(id => id !== undefined),
    deferredUntil: result?.deferredUntil ?? null,
  };
}
