import { withDerivedFamily } from "../../../../items/index.js";
/** Local inbox acknowledgement keeps delivery metadata out of immutable activity history [R2,N26]. */
import { atomic } from "../../io/board.js";
import { openRequests } from "../../io/board/read/shouts.js";
import { COORDINATOR } from "../../../../config/index.js";
import { Refused } from "../../../../kernel/light.js";
import { workerInboxQuery } from "./worker.js";

/**
 * The selection that also finds how far a read may move the seats' cursor past shouts none of them will ever receive.
 * A shout to a seat, a lane, all or the coordination pair never changes audience, so one not delivered now never will
 * be; an item shout can reach a seat later, once it owns or reviews the item, so the cursor stops before the first one
 * not delivered. Why: a seat that is never addressed kept its cursor at its join, and every inbox rescanned the board's
 * whole shout history after it, tens of milliseconds on a board of 23,000 shouts (#2511). It is one statement, so an
 * inbox is one read of the shout table, and the rows tagged 'skip' and 'high' are the cursor's evidence, not mail.
 */
function selectWithReach(board, query, seats, through) {
  const floor = Math.min(...seats.map(seat => seat.agent_last_shout_id));
  const bound = through === undefined ? '' : ' AND shout_id<=?';
  const high = through === undefined ? '(SELECT COALESCE(MAX(shout_id),0) FROM shout)' : '?';
  const rows = board.db.prepare(`WITH delivered AS (${query.sql}${bound})
    SELECT 'mail' AS part, delivered.* FROM delivered
    UNION ALL SELECT 'skip' AS part, * FROM (SELECT * FROM shout WHERE shout_id>? AND shout_id<=${high} AND shout_to LIKE 'item:%'
      AND shout_id NOT IN (SELECT shout_id FROM delivered) ORDER BY shout_id LIMIT 1)
    UNION ALL SELECT 'high' AS part, * FROM (SELECT * FROM shout ORDER BY shout_id DESC LIMIT 1)`)
    .all(...query.bindings, ...(through === undefined ? [] : [through]), floor, ...(through === undefined ? [] : [through]));
  const shouts = rows.filter(row => row.part === 'mail').map(({ part, ...shout }) => shout).toSorted((a, b) => a.shout_id - b.shout_id);
  const skipped = rows.find(row => row.part === 'skip');
  const top = through ?? rows.find(row => row.part === 'high')?.shout_id ?? 0;
  return { shouts, reach: top <= floor ? floor : skipped ? skipped.shout_id - 1 : top };
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
  // Select outside the writer; only monotonic acknowledgements need its short transaction.
  let shouts, reach = 0;
  if (markRead) ({ shouts, reach } = selectWithReach(board, query, query.seats, through));
  else shouts = board.db.prepare(`${query.sql}${through === undefined ? '' : ' AND shout_id<=?'} ORDER BY shout_id`)
    .all(...query.bindings, ...(through === undefined ? [] : [through]));
  const last = shouts.at(-1)?.shout_id;
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
