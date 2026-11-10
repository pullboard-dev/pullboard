/** Coordinator capacity uses local authenticated activity and canonical ready-item blockers [B3,N2]. */
import { COORDINATOR } from '../../light.js';
import { readyItems } from './readiness.js';

/** Display presence may include relay observations; those observations never supply routing capacity. */
export function routingCapacity(board, agents, foreignBlockers, reads = board.nativePorts) {
  // reads.lineSettings is the state capability, handed in by the composition root as a port.
  const seats = reads.withLocalSeatPresence(board, agents).filter(seat => seat.agent_id !== COORDINATOR);
  return { liveOnly: reads.lineSettings(board)['route.liveOnly'],
    liveAgents: seats.filter(seat => seat.presence === 'live').length,
    idleAgents: seats.filter(seat => seat.presence === 'idle').length, readyItems: readyItems(board, foreignBlockers, reads).length };
}
