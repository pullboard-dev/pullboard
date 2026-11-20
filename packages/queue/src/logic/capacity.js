/** Coordinator capacity uses local authenticated activity and canonical ready-item blockers [B3,N2]. */
import { COORDINATOR } from '../../light.js';
import { readyItems } from './readiness.js';

/** Display presence may include relay observations; those observations never supply routing capacity. */
export function routingCapacity(board, agents, foreignBlockers, reads = board.nativePorts) {
  // reads.lineSettings is the state capability, handed in by the composition root as a port.
  const seats = reads.withLocalSeatPresence(board, agents).filter(seat => seat.agent_id !== COORDINATOR);
  const ready = readyItems(board, foreignBlockers, reads);
  const readyByRoute = { mid: 0, strong: 0 };
  for (const item of ready) if (item.item_route in readyByRoute) readyByRoute[item.item_route] += 1;
  return { liveOnly: reads.lineSettings(board)['route.liveOnly'],
    liveAgents: seats.filter(seat => seat.presence === 'live').length,
    idleAgents: seats.filter(seat => seat.presence === 'idle').length, readyItems: ready.length, readyByRoute };
}
