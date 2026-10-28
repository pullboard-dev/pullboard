/** Local inbox acknowledgement keeps delivery metadata out of immutable activity history [R2,N26]. */
import { atomic } from './board.js';
import { openRequests } from './board-read-auxiliary.js';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';
import { workerInboxQuery } from './board-worker-inbox.js';

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
  const agent = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId);
  if (!agent) throw new Refused('NO_AGENT', `no agent ${agentId}`);
  const query = workerInboxQuery(board, agent);
  const shouts = board.db.prepare(`${query.sql}${through === undefined ? '' : ' AND shout_id<=?'} ORDER BY shout_id`)
    .all(...query.bindings, ...(through === undefined ? [] : [through]));
  const last = shouts.at(-1)?.shout_id;
  // Select outside the writer; only monotonic acknowledgements need its short transaction.
  if (markRead && last !== undefined) {
    atomic(board, () => {
      const acknowledge = board.db.prepare('UPDATE agent SET agent_last_shout_id=MAX(agent_last_shout_id,?) WHERE agent_id=?');
      for (const seat of query.seats) acknowledge.run(last, seat.agent_id);
    });
  }
  if (agentId !== COORDINATOR) return shouts;
  const requests = openRequests(board);
  const ids = new Set(requests.map((shout) => shout.shout_id));
  return [...requests, ...shouts.filter((shout) => !ids.has(shout.shout_id))];
}
