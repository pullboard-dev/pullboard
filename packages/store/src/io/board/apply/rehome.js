import { applyRehomeItem as applyRehomeRecord } from "../../../../../items/index.js";
import { reviewPolicyChange } from "../../../../../verify/index.js";
import { saveItemReviewPolicy } from "../../../../../verify/index.js";
import { now } from "../query.js";
import { boardId } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { moveItem } from "../../board.js";
import { validateItemAddition } from "../add.js";

/** Apply a source move once, retaining its source MOVEID receipt [E15,H16]. */
export function applyRehomeItem(board, record, options) {
  return applyRehomeRecord(board, { record, ...options }, { atomic, boardId, logEvent, moveItem, validateItemAddition, now, reviewPolicyChange, saveItemReviewPolicy });
}
