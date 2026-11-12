import { PERSON } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { Refused } from "../../../../../kernel/index.js";
import { coordinatorOnly } from "../../board.js";

/**
 * Release a held lane.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, asPerson?: boolean, channel?: string }} who
 */
export function releaseLane(board, lane, { agentId, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'releases a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person release through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  atomic(board, () => {
    const { changes } = board.db.prepare('DELETE FROM hold WHERE hold_lane = ?').run(lane);
    if (!changes) throw new Refused('NOT_HELD', `the ${lane} lane is not held`);
    logEvent(board, by, 'unhold', null, { lane, ...(asPerson ? { channel } : {}) });
  });
}
