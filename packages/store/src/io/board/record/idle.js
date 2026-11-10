import { recordNextIdle as recordNextIdleObservation } from "../../../logic/board/stats.js";
import { agentById } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";

/** Persist next's observed idle cause through the normal ordered actor boundary [R2,N2]. */
export function recordNextIdle(board, options) { return recordNextIdleObservation(board, options, { atomic, logEvent, agentById }); }
