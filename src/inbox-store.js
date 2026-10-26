/** Local inbox acknowledgement keeps delivery metadata out of immutable activity history [R2,N26]. */
import { atomic } from './board.js';
import { openRequests } from './board-read-auxiliary.js';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';
import {
  UNREAD_SHOUT_SQL as UNREAD_SQL,
  unreadShoutBindings,
} from './shout-audience.js';

/**
 * Unread shouts for an agent, oldest first; an unrecorded delivery can inspect them without consuming them.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {any[]}
 */
export function inbox(board, agentId, { through, markRead = true } = {}) {
  if (through !== undefined && (!Number.isSafeInteger(through) || through < 0)) {
    throw new Refused('BAD_ACTIVITY_CURSOR', 'the inbox high-water mark is a nonnegative shout id; read inbox again');
  }
  return atomic(board, () => {
    const agent = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId);
    if (!agent) throw new Refused('NO_AGENT', `no agent ${agentId}`);
    const shouts = board.db
      .prepare(`SELECT * ${UNREAD_SQL}${through === undefined ? '' : ' AND shout_id<=?'} ORDER BY shout_id`)
      .all(...unreadShoutBindings(agent.agent_last_shout_id, agentId, agent.agent_lane), ...(through === undefined ? [] : [through]));
    const last = shouts.at(-1)?.shout_id ?? agent.agent_last_shout_id;
    if (markRead) board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ?').run(last, agentId);
    if (agentId !== COORDINATOR) return shouts;
    const requests = openRequests(board);
    const ids = new Set(requests.map((shout) => shout.shout_id));
    return [...requests, ...shouts.filter((shout) => !ids.has(shout.shout_id))];
  });
}
