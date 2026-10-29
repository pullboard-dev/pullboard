import { forgetHoldMaintenance } from './conditional-holds.js';
import { applyItemHoldRelease } from './item-holds.js';
import { itemHold } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { coordinatorOnly } from './board.js';
import { setItem } from './board.js';

/** Lift an item hold through its existing native operation. */
export function releaseItemHold(board, id, options) {
  return applyItemHoldRelease(board, id, options, { coordinatorOnly, atomic, itemHold, setItem, logEvent, forgetHoldMaintenance });
}
