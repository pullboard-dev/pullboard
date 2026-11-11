import { itemReviewPolicy } from "../../../../verify/index.js";
import { twoTierReviews } from "../../../../verify/index.js";
/** Re-homing facades share the board's ordinary mutations without growing its central store. */
import {
  itemRedirect as readItemRedirect,
  rehomeImport as readRehomeImport,
  rehomeDestinationItemId as destinationRehomeId,
  rehomeItem as recordRehome,
  reserveRehomeItemId as reserveRehomeId,
} from "../../../../items/index.js";
import {
  boardId,
  current,
  itemById,
  now,
} from "./query.js";
import {
  atomic,
  logEvent,
} from "./event/log.js";
import { Refused } from "../../../../kernel/index.js";

/** Preserve an existing check only when the validated source move carries that exact check [E15]. */
export function validateRehomeCheck(by, check, sourceMove) {
  const source = sourceMove?.item;
  if (sourceMove.agentId !== by || !/^[A-Za-z0-9_-]{1,80}$/u.test(sourceMove.moveId ?? '')
      || !Number.isSafeInteger(sourceMove.sourceReceipt?.eventId) || sourceMove.sourceReceipt.eventId < 1
      || sourceMove.sourceReceipt.resultDigest !== sourceMove.digest || typeof source?.item_check !== 'string'
      || source.item_check !== check || !['open', 'verified'].includes(source.item_status)) {
    throw new Refused('COORDINATOR_CHECK', 'preserve an existing item check only as part of its exact open or verified source move');
  }
  return source.item_check;
}

/** Reserve an append-only item ID through a replayable destination operation [E15]. */
export function reserveRehomeItemId(board, sourceBoardId, sourceMoveId, options) {
  return reserveRehomeId(board, sourceBoardId, sourceMoveId, options, { atomic, boardId, logEvent });
}

/** Read the retained destination from a source-board tombstone [E15]. */
export function itemRedirect(board, id) { return readItemRedirect(board, id); }

/** Read the imported source acceptance as attributed metadata, not a destination verdict [E15]. */
export function rehomeImport(board, id) { return readRehomeImport(board, id); }

/** Resolve a previously imported source item ID on this destination board [E15]. */
export function rehomeDestinationItemId(board, sourceBoardId, sourceItemId) {
  return destinationRehomeId(board, sourceBoardId, sourceItemId, boardId);
}

/** Record the one ordered source-board move and its permanent old-ID redirect [E15]. */
export function rehomeItem(board, id, options) {
  return recordRehome(board, id, options, { atomic, boardId, current, itemById, logEvent, itemReviewPolicy, twoTierReviews });
}
