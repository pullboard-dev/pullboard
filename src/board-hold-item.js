import { holdUntilKind } from './board-conditional-holds.js';
import { forgetHoldMaintenance } from './board-conditional-holds.js';
import { rememberHoldCondition } from './board-conditional-holds.js';
import { applyItemHold } from './item-holds.js';
import { now } from './board-query.js';
import { getItem } from './board-query.js';
import { itemHold } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { coordinatorOnly } from './board.js';
import { postRigorNotices } from './board.js';
import { setItem } from './board.js';

/** Hold an item through the unchanged coordinator transaction. */
export function holdItem(board, id, options) {
  return applyItemHold(board, id, options, { coordinatorOnly, atomic, getItem, setItem, now, logEvent, postRigorNotices, itemHold, holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine: board.nativePorts.staleStateEngine });
}
