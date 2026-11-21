/** The review job a sprint landing queues for each sprint item it lands, so the review exists before any reviewer reserves it [C7,#12503]. */

import { createJob } from '../../../../jobs/index.js';
import { reviewJobId } from '../../../../jobs/index.js';
import { itemPace } from '../../../../store/index.js';

/**
 * Queue one review job for every sprint item a land job just landed. Why: a sprint item lands before its verdict, and its
 * review job was created only when a reviewer happened to reserve it, so an unreserved landed item had no job to offer or
 * count. The pace is read from the item rows the receipt apply already loaded, so a landing of steady or strict items makes
 * no added board call. The job id names the item and creating an id that exists changes nothing, so a second receipt makes
 * no second job and a job a reviewer has reserved keeps its lease.
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {{ items: Array<{ item_id: number, item_frozen?: string } | null | undefined> }} landed
 * @returns {string[]} the review job ids for the sprint items, in item order
 */
export function queueLandedReviews(board, { items }) {
  const sprint = items.filter(item => item && itemPace(item) === 'sprint').map(item => item.item_id);
  for (const item of sprint) createJob(board.db, { id: reviewJobId(item), kind: 'review', item });
  return sprint.map(reviewJobId);
}
