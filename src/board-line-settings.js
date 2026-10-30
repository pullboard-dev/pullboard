/** The board's line-setting move, composed from the seats cell's rule and the store's writers [R1,R2,C7]. */
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { setLineSetting as recordLineSetting } from './line-settings.js';

/**
 * Record a line setting through the board's own transaction and event log.
 *
 * The seats cell owns the rule but not the writers, so the store passes them in as an explicit port.
 */
export function setLineSetting(board, options) {
  return recordLineSetting(board, options, { atomic, logEvent });
}
