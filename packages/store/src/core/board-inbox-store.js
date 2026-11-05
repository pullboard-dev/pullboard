import { withDerivedFamily } from "../../../../src/family-declaration.js";
/** Local inbox acknowledgement keeps delivery metadata out of immutable activity history [R2,N26]. */
import { atomic } from "../shell/board.js";
import { openRequests } from "../shell/board-read-auxiliary.js";
import { COORDINATOR } from "../../../config/index.js";
import { Refused } from "../../../kernel/core.js";
import { workerInboxQuery } from "./board-worker-inbox.js";

/**
 * How far a read may move the seats' cursor past shouts none of them will ever receive. A shout to a seat, a lane, all
 * or the coordination pair never changes audience, so one not delivered now never will be; an item shout can reach a
 * seat later, once it owns or reviews the item, so the cursor stops before the first one not delivered.
 * Why: a seat that is never addressed kept its cursor at its join, and every inbox rescanned the board's whole shout
 * history after it, tens of milliseconds on a board of 23,000 shouts (#2511).
 */
function readThrough(board, seats, delivered, through) {
  const floor = Math.min(...seats.map(seat => seat.agent_last_shout_id));
  const high = through ?? board.db.prepare('SELECT COALESCE(MAX(shout_id),0) AS id FROM shout').get().id;
  if (high <= floor) return floor;
  const received = new Set(delivered.map(shout => shout.shout_id));
  for (const { shout_id: id } of board.db.prepare("SELECT shout_id FROM shout WHERE shout_id>? AND shout_id<=? AND shout_to LIKE 'item:%' ORDER BY shout_id").all(floor, high)) {
    if (!received.has(id)) return id - 1;
  }
  return high;
}

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
  const agent = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId));
  if (!agent) throw new Refused('NO_AGENT', `no agent ${agentId}`);
  const query = workerInboxQuery(board, agent);
  const shouts = board.db.prepare(`${query.sql}${through === undefined ? '' : ' AND shout_id<=?'} ORDER BY shout_id`)
    .all(...query.bindings, ...(through === undefined ? [] : [through]));
  const last = shouts.at(-1)?.shout_id;
  // Select outside the writer; only monotonic acknowledgements need its short transaction.
  const reach = markRead ? readThrough(board, query.seats, shouts, through) : 0;
  const acknowledged = Math.max(last ?? 0, reach);
  if (markRead && query.seats.some(seat => seat.agent_last_shout_id < acknowledged)) {
    atomic(board, () => {
      const acknowledge = board.db.prepare('UPDATE agent SET agent_last_shout_id=MAX(agent_last_shout_id,?) WHERE agent_id=?');
      for (const seat of query.seats) acknowledge.run(acknowledged, seat.agent_id);
    });
  }
  if (agentId !== COORDINATOR) return shouts;
  const requests = openRequests(board);
  const ids = new Set(requests.map((shout) => shout.shout_id));
  return [...requests, ...shouts.filter((shout) => !ids.has(shout.shout_id))];
}
