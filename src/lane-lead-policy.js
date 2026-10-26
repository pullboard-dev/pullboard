/** Coordinator-only ordered lane policy mutation [B21,H16]. */
import { Refused } from './refused.js';
import { laneLeads } from './lane-lead.js';

/** Name an existing same-lane seat through the normal coordinator-only ordered transaction. */
export function applyLaneLead(board, { agentId, lane, seat, lanes }, { atomic, logEvent }) {
  return atomic(board, () => {
    if (agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'ask the coordinator to name or remove a lane lead');
    if (!lanes.includes(lane) || lane === 'coordinator') throw new Refused('BAD_LANE_LEAD', 'name a configured non-coordinator lane');
    if (seat !== null && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? AND agent_lane=?').get(seat, lane)) {
      throw new Refused('BAD_LANE_LEAD', 'name an existing seat in the same lane, or use off');
    }
    const leads = laneLeads(board);
    if (seat === null) delete leads[lane]; else leads[lane] = seat;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run('lane_leads', JSON.stringify(leads));
    logEvent(board, agentId, 'lane-lead', null, { lane, seat });
    return leads;
  });
}

