import { applyRehomeItem as applyRehomeRecord } from './item-rehome.js';
import { reviewPolicyChange } from './review-independence.js';
import { saveItemReviewPolicy } from './review-independence.js';
import { now } from './board-query.js';
import { boardId } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { moveItem } from './board.js';
import { validateItemAddition } from './board-add-item.js';

/** Apply a source move once, retaining its source MOVEID receipt [E15,H16]. */
export function applyRehomeItem(board, record, options) {
  return applyRehomeRecord(board, { record, ...options }, { atomic, boardId, logEvent, moveItem, validateItemAddition, now, reviewPolicyChange, saveItemReviewPolicy });
}
