/** Read replacement authority only from typed engine events, never from a person's prose [B3,H16]. */
import { Refused } from './refused.js';

/** Find this outgoing seat's one durable hand-off, retaining its first takeover. */
export function agentHandoff(board, outgoing) {
  const open = board.db.prepare("SELECT * FROM event WHERE event_kind='handoff-open' AND event_by=? ORDER BY event_id DESC LIMIT 1").get(outgoing);
  return open ? itemHandoff(board, open.item_id) : null;
}

/** Read one hand-off and its timed takeover from the indexed event prefix. */
export function itemHandoff(board, item) {
  const open = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='handoff-open' ORDER BY event_id LIMIT 1").get(item);
  if (!open) return null;
  const taken = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='handoff-take' ORDER BY event_id LIMIT 1").get(item);
  return { item, outgoing: open.event_by, openedAt: open.event_at,
    incoming: taken?.event_by ?? null, takenAt: taken?.event_at ?? null };
}

/** Refuse a replaced seat before any move, except a message on its exact hand-off item. */
export function handoffMoveProblem(board, actor, operation, args) {
  if (typeof actor !== 'string' || actor === 'person' || actor === 'coordinator') return;
  const handoff = agentHandoff(board, actor);
  if (!handoff?.takenAt) return;
  if (operation === 'shout' && args?.[0]?.item === handoff.item) return;
  return new Refused('AGENT_REPLACED', `${actor} was taken over by ${handoff.incoming} at ${handoff.takenAt}; only pullboard shout --item ${handoff.item} "<answer for the incoming agent>" remains available`);
}

/** Raise the same replacement refusal at native writes and deterministic engine dispatch. */
export function requireHandoffActive(board, actor, operation, args) {
  const problem = handoffMoveProblem(board, actor, operation, args);
  if (problem) throw problem;
}
