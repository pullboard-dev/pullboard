/** Read the claim, submit, release and merged events that give per-seat flow, read-only [C7,#6136]. */
import { AGENT_FLOW_KINDS } from '../logic/agents.js';

/**
 * Those events up to a moment, in board order.
 *
 * Why: a hold that began before the window still counts inside it, so the read starts at the beginning of the board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{until: number}} window - epoch ms
 * @returns {{kind: string, seat: string, item: number|null, at: number}[]}
 */
export function readAgentFlowEvents(db, { until }) {
  const marks = AGENT_FLOW_KINDS.map(() => '?').join(',');
  return db.prepare(`SELECT event_kind AS kind, event_by AS seat, item_id AS item, event_at AS at FROM event
    WHERE event_kind IN (${marks}) AND event_at < ? ORDER BY event_id`).all(...AGENT_FLOW_KINDS, new Date(until).toISOString())
    .map(row => ({ ...row, at: Date.parse(row.at) }));
}
