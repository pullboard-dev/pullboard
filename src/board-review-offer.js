import * as capacity from './line-capacity-board.js';
import { nextFor } from './board-next-for.js';
import {
  listItems,
  reviewHolder,
  reviewQueue,
} from './board-query.js';
import { overdueReview } from './review-routing.js';

/** Offer an eligible review at the queue ratio without claiming or reserving anything [Q1,V15]. */
export function reviewOffer(board, who) {
  return capacity.reviewOffer(board, who, nextFor, { reviewQueue, reviewHolder, listItems, overdueReview });
}
