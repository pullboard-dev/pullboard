/** Local presence filters new advice only; sealed claims keep their recorded semantics [B3,N2,H16]. */
import { COORDINATOR } from '../../../config/index.js';
import { lineSettings } from '../../../state/light.js';

/**
 * A current read may withhold new work; an ordered operation never depends on private heartbeat state.
 * The store supplies its local presence projection, so seat routing never loads the presence reader.
 */
export function liveRouteProblem(board, agentId, { withLocalSeatPresence }) {
  if (board.executionEngineVersion !== undefined || !lineSettings(board)['route.liveOnly']) return null;
  const [seat] = withLocalSeatPresence(board, [{ agent_id: agentId }]);
  return seat.presence === 'live' ? null
    : `the live-only line routes new work to locally live seats; run pullboard heartbeat in ${agentId}'s checkout, then pullboard next`;
}

/**
 * Why a lane has nothing to claim (N13): a lane whose items still await verdicts is not done, since
 * a rejected item comes back to it; the coordinator builds only its own lane's items.
 *
 * @param {any[]} items - Items not yet verified or withdrawn, as the agent may see them.
 * @param {string} lane
 * @param {string} routed
 * @returns {string}
 */
export function idleReason(items, lane, routed) {
  const reason = `no open ${routed}items in the ${lane} lane`;
  if (lane === COORDINATOR) return `${reason}; lane items are built from each lane's own worktree`;
  const awaiting = items.filter((entry) => entry.item_lane === lane && entry.item_status === 'submitted').map((entry) => `#${entry.item_id}`);
  if (!awaiting.length) return reason;
  return `${reason}; ${awaiting.join(', ')} still await${awaiting.length === 1 ? 's' : ''} a verdict, and a rejected item comes back to this lane. A lane is done when its items are verified`;
}
