import { recordNextIdle as recordNextIdleObservation } from './board-stats.js';
import { agentById } from './seats.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';

/** Persist next's observed idle cause through the normal ordered actor boundary [R2,N2]. */
export function recordNextIdle(board, options) { return recordNextIdleObservation(board, options, { atomic, logEvent, agentById }); }
