/**
 * A queued accept: with verify.queueAccept on, `verify accept` offers the item's frozen check as one runner job, reserves
 * the review to the accepting seat and returns at once, as submit offers its gate and returns. The verdict is settled
 * from the job's receipt, not here, so a reviewer's tool timeout can never kill a check that is still running [C7,V4,#3161].
 */
import { Refused } from '../../../../../packages/kernel/light.js';
import { renewReview } from '../../../../../packages/jobs/index.js';
import { reserveReview } from '../../../../../packages/jobs/index.js';
import { reviewJobId } from '../../../../../packages/jobs/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { offerAcceptCheck } from './pull.js';

/** The step a queued accept writes on its item's review job: which check job settles the verdict, for which source and bar. */
export const ACCEPT_QUEUED = 'accept-queued';
// Budget: how long the reservation outlives the offer; the check job has gate.runnerWaitMs to be claimed and its own limits to finish.
const RESERVE_MS = 30 * 60_000;

/**
 * Whether verify accept should queue its check instead of running it: the setting is on and the item has a frozen check.
 *
 * @param {{ verify?: { queueAccept?: boolean } }} config
 * @param {string | null | undefined} check - The item's frozen check, or none.
 * @returns {boolean}
 */
export function queuesAccept(config, check) {
  return config?.verify?.queueAccept === true && Boolean(check);
}

/**
 * Offer the frozen check as a runner job and reserve the item's review to the accepting seat.
 *
 * @param {object} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {{ item: number, me: { id: string }, commit: string, main: string, check: string, digest: string }} fields
 * @returns {Promise<{ item: number, decision: 'QUEUED', queued: true, checkJob: string, reservedTo: string, commit: string, until: number }>}
 */
export async function queueAccept(ctx, board, { item, me, commit, main, check, digest }) {
  const now = Date.now();
  const reserved = reserveReview(board.db, item, me.id, { now, leaseMs: RESERVE_MS });
  // Another seat's live review keeps its hold: a queued accept never takes it over.
  if (!reserved.reserved && reserved.holder !== me.id) {
    throw new Refused('REVIEW_RESERVED', `item #${item} is reserved to ${reserved.holder} for its review`, `wait for ${reserved.holder} to finish, or ask the coordinator to release the reservation`);
  }
  renewReview(board.db, item, me.id, { now, leaseMs: RESERVE_MS });
  const offered = await offerAcceptCheck(ctx, board, { item, commit, main, command: check });
  writeStep(board.db, reviewJobId(item), ACCEPT_QUEUED, { checkJob: offered.job, ref: offered.ref, commit, main, digest, reviewer: me.id, policy: ctx.config?.verify?.policy, family: ctx.config?.verify?.family }, { seq: now, now });
  return { item, decision: 'QUEUED', queued: true, checkJob: offered.job, reservedTo: me.id, commit, until: now + RESERVE_MS };
}
