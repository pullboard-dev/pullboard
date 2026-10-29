import { applyHealthFindings } from './board-health.js';
import { atomic } from './board-event-log.js';
import { insertShout } from './board-shout.js';

/** Record one health snapshot through its unchanged transactional implementation [A6]. */
export function recordHealthFindings(board, options) {
  return applyHealthFindings(board, options, { atomic, insertShout, normalizedDispatch: board.nativePorts.normalizedDispatch, rejectedWorkReturns: board.nativePorts.rejectedWorkReturns });
}
