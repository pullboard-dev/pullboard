import { applyHealthFindings } from "../health.js";
import { atomic } from "../event/log.js";
import { insertShout } from "../shout.js";

/** Record one health snapshot through its unchanged transactional implementation [A6]. */
export function recordHealthFindings(board, options) {
  return applyHealthFindings(board, options, { atomic, insertShout, normalizedDispatch: board.nativePorts.normalizedDispatch, rejectedWorkReturns: board.nativePorts.rejectedWorkReturns });
}
