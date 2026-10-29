import { applyStaleState } from './board-stale-state-store.js';
import { getItem } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { setItem } from './board.js';
import { releaseItemHold } from './board-release-item-hold.js';
import { insertShout } from './board-shout.js';

/** Apply one captured stale-state plan under authenticated coordinator authority. */
export function maintainStaleState(board, options) {
  return applyStaleState(board, options, { atomic, getItem, setItem, releaseItemHold, logEvent, insertShout });
}
