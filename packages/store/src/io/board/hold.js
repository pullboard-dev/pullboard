/** The board's coordinator takeover move, composed from the seats cell's hold and the store's writers [E19,C7]. */
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { takeCoordinator as recordTakeover } from "../../../../seats/index.js";

/**
 * Take the coordinator hold through the board's own transaction and event log.
 *
 * The seats cell owns the hold rule but not the writers, so the store passes them in as an explicit port.
 */
export function takeCoordinator(board, options) {
  return recordTakeover(board, options, { atomic, logEvent });
}
