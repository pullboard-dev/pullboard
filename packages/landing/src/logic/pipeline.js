/** Pipelined landing admission: a pure rule for when a new batch may start gating beside one in flight [C7,#3155]. */

/** Most batches in flight at once when the landing.pipeline setting is on. */
export const PIPELINE_DEPTH = 2;

/**
 * Decide whether a new batch may be admitted, purely. With the pipeline on, a batch is admitted while fewer than two
 * are in flight; with it off, only when none is, which is today's one-at-a-time landing. Why: two in flight keeps the
 * runners busy while a red still rebuilds at most one speculative batch.
 *
 * @param {{ inFlight: { id: string, items?: number[] }[], pipeline: boolean }} state - the in-flight batch records
 *   (the shape planQueue returns) and the landing.pipeline setting.
 * @returns {boolean} true when a new batch may start.
 */
export function admitBatch({ inFlight, pipeline }) {
  return inFlight.length < (pipeline ? PIPELINE_DEPTH : 1);
}
