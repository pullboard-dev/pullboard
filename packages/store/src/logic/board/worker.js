import { withDerivedFamilies } from "../../../../items/light.js";
/** One inbox follows a canonical worker session, never the parent shared with its helpers [B7,N19]. */
import {
  COORDINATION_SHOUT,
  UNREAD_SHOUT_SQL,
  unreadShoutBindings,
} from "./audience.js";

/** Resolve registered aliases once; missing or damaged session metadata never groups seats. */
export function workerInboxSeats(board, agent) {
  const digest = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?')
    .get(`agent_session:${agent.agent_id}`)?.meta_value;
  if (!/^[a-f0-9]{64}$/u.test(digest ?? '')) return [agent];
  // Walk the session keys by their primary-key range, then each seat by id: never every seat on the board (#2421).
  return withDerivedFamilies(board, board.db.prepare(`SELECT agent.* FROM board_meta CROSS JOIN agent
    ON agent.agent_id=substr(board_meta.meta_key, 15) AND board_meta.meta_key='agent_session:' || agent.agent_id
    WHERE board_meta.meta_key >= 'agent_session:' AND board_meta.meta_key < 'agent_session;' AND board_meta.meta_value=?
    ORDER BY agent.agent_id`).all(digest));
}

/** Select each unread message once using its recipient's cursor, so old uneven cursors lose no mail. */
export function workerInboxQuery(board, agent, columns = '*') {
  const seats = workerInboxSeats(board, agent);
  if (seats.length === 1) return { seats, sql: `SELECT ${columns} ${UNREAD_SHOUT_SQL} WHERE 1`,
    bindings: unreadShoutBindings(agent.agent_last_shout_id, agent.agent_id, agent.agent_lane) };
  const members = seats.map(seat => ({ id: seat.agent_id, lane: seat.agent_lane, cursor: seat.agent_last_shout_id }));
  return { seats, bindings: [JSON.stringify(members), Math.min(...members.map(seat => seat.cursor))],
    // handoffs is materialized once: the per-row item check reads it, never the event table, so a long backlog of
    // item-addressed shouts costs one lookup per row, not one event scan per row (#1490).
    sql: `WITH inbox_seats AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,
      json_extract(value,'$.lane') AS lane, json_extract(value,'$.cursor') AS cursor FROM json_each(?)),
      handoffs AS MATERIALIZED (SELECT item_id, event_by FROM event WHERE event_kind IN ('handoff-open','handoff-take') AND item_id IS NOT NULL)
      SELECT ${columns} FROM shout WHERE shout_id>? AND shout_from NOT IN (SELECT id FROM inbox_seats)
      AND EXISTS (SELECT 1 FROM inbox_seats seat WHERE shout_id>seat.cursor AND
        (shout_to IN ('all',seat.id,seat.lane) OR (shout_to='${COORDINATION_SHOUT}' AND seat.id IN ('coordinator','person'))
        OR EXISTS (SELECT 1 FROM item WHERE item_id=CAST(substr(shout_to,6) AS INTEGER) AND shout_to='item:' || item_id AND
          (seat.id='coordinator' OR COALESCE(item_owner,item_built_by)=seat.id OR COALESCE(item_review_by,item_verified_by)=seat.id
          OR EXISTS (SELECT 1 FROM handoffs WHERE handoffs.item_id=item.item_id AND handoffs.event_by=seat.id)))))` };
}
