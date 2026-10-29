import { applyLaneLead } from './lane-lead-policy.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';

/** Name a lane lead only through coordinator-owned ordered policy [B21]. */
export function setLaneLead(board, options) {
  return applyLaneLead(board, options, { atomic, logEvent });
}
