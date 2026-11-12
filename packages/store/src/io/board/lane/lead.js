import { applyLaneLead } from "../../../../../seats/index.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";

/** Name a lane lead only through coordinator-owned ordered policy [B21]. */
export function setLaneLead(board, options) {
  return applyLaneLead(board, options, { atomic, logEvent });
}
