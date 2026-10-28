/** Coordinator capacity uses local authenticated activity and canonical ready-item blockers [B3,N2]. */
import { COORDINATOR } from './config.js';
import { lineSettings } from './line-settings-read.js';
import { withLocalSeatPresence } from './seat-presence.js';
import { readyItems } from './queue-readiness.js';

/** Display presence may include relay observations; those observations never supply routing capacity. */
export function routingCapacity(board, agents) {
  const seats = withLocalSeatPresence(board, agents).filter(seat => seat.agent_id !== COORDINATOR);
  return { liveOnly: lineSettings(board)['route.liveOnly'],
    liveAgents: seats.filter(seat => seat.presence === 'live').length,
    idleAgents: seats.filter(seat => seat.presence === 'idle').length, readyItems: readyItems(board).length };
}
