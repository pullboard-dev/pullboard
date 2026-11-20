/** The main-wide test job a sprint landing queues on the landed tip; `pullboard serve` hands in the request builder beside the screen starter [V2,M1,#12182]. */

import { itemPace } from '../../../../store/index.js';
import { offerJob } from '../jobs.js';

/** The id prefix of a post-land test job; the landed tip follows it, so one tip holds one job. */
export const POST_LAND_JOB_PREFIX = 'post-land:';

/** The request builder this process's board API calls; null until a host provides one. */
let requestBuilder = null;

/**
 * Provide the function that builds the main-wide test job for a landed tip: build({ root, trunk }) answers
 * { needs, request } for a test job the runner can claim, or null when the project names no gate command.
 * Why a provider: the test job's entry (testJobEntry) and its needs are the CLI's, so `pullboard serve` hands the
 * builder in beside the screen starter and the board API keeps no import of the CLI [V2,M1].
 * @param {((request: { root: string, trunk: string }) => { needs: string[], request: object } | null) | null} build
 */
export function providePostLandMainTest(build) {
  requestBuilder = typeof build === 'function' ? build : null;
}

/**
 * Queue one main-wide test job on the tip a land job just landed, when it landed a sprint item, carrying the land job and
 * those sprint items for the receipt that reads its result. Why: after a sprint landing nothing ran main's tests, so a
 * test the landed work broke on main was seen only by a hand command. The pace is read from the item rows the receipt
 * apply already loaded, so a landing of steady or strict items, or a board with no builder, makes no added board call.
 * The job id names the tip, so a second receipt for the same tip queues none. A builder that throws is logged, never
 * thrown into the receipt apply.
 * @param {{ db: import('node:sqlite').DatabaseSync, gitRoot?: string }} board
 * @param {{ job: string, trunk: string, items: Array<{ item_id: number, item_frozen?: string } | null | undefined>, queue?: object | null }} landed
 * @returns {string | null} the queued job's id, or null when none was queued
 */
export function queuePostLandMainTest(board, { job, trunk, items, queue = null }) {
  const build = requestBuilder;
  if (!build) return null;
  const sprint = items.filter(item => item && itemPace(item) === 'sprint').map(item => item.item_id);
  if (!sprint.length || !board.gitRoot) return null;
  try {
    const built = build({ root: board.gitRoot, trunk });
    if (!built) return null;
    const id = `${POST_LAND_JOB_PREFIX}${trunk}`;
    offerJob(board.db, { id, kind: 'test', needs: built.needs ?? [], candidate: trunk, base: trunk, request: built.request, payload: { postLand: { job, items: sprint } } }, queue);
    return id;
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} main-wide test after land job ${job} not queued: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    return null;
  }
}
