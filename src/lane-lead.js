/** Explicit lane coordination never grants coordinator or person authority [B21,B26]. */
import { Refused } from './refused.js';
import { LANE_LEAD_ENGINE } from './lane-lead-engine.js';

/** Read only valid current lane seats; stale policy never grants a different lane authority. */
export function laneLeads(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('lane_leads');
  const values = row ? JSON.parse(row.meta_value) : {};
  return Object.fromEntries(Object.entries(values).filter(([lane, seat]) => lane !== 'coordinator' && typeof seat === 'string'
    && board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? AND agent_lane=?').get(seat, lane)));
}

/** Route only explicitly typed upward coordination; ordinary and item-specific notes stay unchanged. */
export function routeLaneMessage(board, message, engine) {
  const { from, to, item } = message;
  const kind = message.kind ?? (engine >= LANE_LEAD_ENGINE && message.decision && message.answers == null
    && to === 'coordinator' && item === undefined ? 'question' : undefined);
  if (kind === undefined) return message;
  if (engine < LANE_LEAD_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade every linked device before sending typed lane coordination');
  if (!['question', 'blocker', 'decision', 'status'].includes(kind)) throw new Refused('BAD_MESSAGE_KIND', 'use question, blocker or decision for lane coordination');
  if (kind === 'status') throw new Refused('STATUS_IS_ACTIVITY', 'status belongs in board activity, not a shout; keep working on your item');
  if (item !== undefined) throw new Refused('LANE_MESSAGE_ITEM', 'keep item notes separate from lane coordination; omit --kind for an item message');
  const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(from)?.agent_lane;
  const lead = lane && laneLeads(board)[lane];
  if (kind === 'decision' && from !== 'coordinator' && lead !== from) throw new Refused('NOT_LANE_LEAD', 'ask your lane lead to send the lane decision upward');
  return { ...message, to: to === 'coordinator' && lead && lead !== from && ['question', 'blocker'].includes(kind) ? lead : to,
    detail: { ...message.detail, messageKind: kind } };
}

/** A lead may escalate only a real decision addressed to it from its own lane. */
export function leadOwnsDecision(board, ask, actor) {
  const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(ask.shout_from)?.agent_lane;
  return (board.executionEngineVersion === undefined || board.executionEngineVersion >= LANE_LEAD_ENGINE) && ask.shout_decision && ask.shout_to === actor && laneLeads(board)[lane] === actor;
}

/** Identify only the existing addressed lead's genuine escalation, never an arbitrary caller flag. */
export function isLaneEscalation(board, ask) {
  if (ask.shout_from === 'coordinator' || ask.shout_to !== 'coordinator' || ask.shout_answers === null) return false;
  const original = board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(ask.shout_answers);
  return Boolean(original?.shout_decision && original.shout_to === ask.shout_from);
}

/** Floor only operations that execute the new lane policy; historical untyped messages retain old semantics. */
export function laneAnswerFloor(board, args) {
  if (!board?.db || !Number.isSafeInteger(args?.[0]) && typeof args?.[0] !== 'string') return 1;
  const ask = board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(args?.[0]);
  return ask && (leadOwnsDecision(board, ask, args?.[1]?.agentId) || isLaneEscalation(board, ask)) ? LANE_LEAD_ENGINE : 1;
}

/** Existing explicit decision questions opt in only when a lane has a named lead. */
export function laneMessageFloor(board, message) {
  if (message?.kind !== undefined) return LANE_LEAD_ENGINE;
  if (!board?.db || !message?.decision || message.answers != null || message.to !== 'coordinator' || message.item !== undefined) return 1;
  if (typeof message.from !== 'string') return 1;
  const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(message.from)?.agent_lane;
  return lane && laneLeads(board)[lane] ? LANE_LEAD_ENGINE : 1;
}
