import { Refused } from "../../../../kernel/light.js";
import { atomic } from "../../io/board.js";
import { logEvent } from "../../io/board/event/log.js";

/** The fixed set of actions that settle an inbox entry [C7,#8519]. */
export const ENTRY_ACTIONS = Object.freeze(['answer', 'act', 'archive', 'escalate']);

/**
 * Which of the four actions each shout kind allows.
 * Why: a decision is settled by an answer or by passing it up, never by archiving it unread; a status note needs no answer.
 */
export const KIND_ACTIONS = Object.freeze({
  question: ['answer', 'archive', 'escalate'],
  blocker: ['answer', 'act', 'escalate'],
  decision: ['answer', 'escalate'],
  exception: ['act', 'archive', 'escalate'],
  idea: ['act', 'archive'],
});

/** A shout with no kind is a status note: acted on or archived, never answered. */
const PLAIN = Object.freeze(['act', 'archive']);

/**
 * The actions an entry of this kind allows.
 *
 * @param {string|null|undefined} kind
 * @returns {string[]}
 */
export function allowedActions(kind) {
  return [...(KIND_ACTIONS[kind ?? ''] ?? PLAIN)];
}

/**
 * Refuse an action the entry's kind does not allow.
 *
 * @param {{ id: number, kind: string|null|undefined, action: string }} entry
 * @returns {void}
 */
export function requireAllowedAction({ id, kind, action }) {
  if (!ENTRY_ACTIONS.includes(action)) throw new Refused('ENTRY_ACTION', `${JSON.stringify(action)} is not an inbox action`, `use one of ${ENTRY_ACTIONS.join(', ')}`);
  const allowed = allowedActions(kind);
  if (!allowed.includes(action)) throw new Refused('ENTRY_ACTION_NOT_ALLOWED', `entry #${id} is a ${kind ?? 'status'} shout, which does not allow ${action}`, `settle it with ${allowed.join(', ')}`);
}

/** One printed line per entry still awaiting an action. */
export function entryLines(entries) {
  return entries.map(entry => `entry #${entry.id} ${entry.kind ?? 'status'} from ${entry.from}: ${entry.text}; settle with ${allowedActions(entry.kind).join(', ')}`);
}

/**
 * The shouts addressed to this seat that no allowed action has settled, newest first.
 * Why events: the shout table keeps no kind, and an action is an appended event, so nothing already recorded is rewritten [C7,#8519].
 *
 * @param {any} board
 * @param {string} agentId
 * @param {number} [limit]
 * @returns {Array<{ id: number, kind: string|null, from: string, text: string }>}
 */
export function openEntries(board, agentId, limit = 20) {
  return board.db.prepare(`SELECT s.shout_id AS id, json_extract(e.event_detail, '$.messageKind') AS kind, s.shout_from AS "from", s.shout_text AS text
    FROM event e JOIN shout s ON s.shout_id = json_extract(e.event_detail, '$.shout')
    WHERE e.event_kind = 'shout' AND json_extract(e.event_detail, '$.to') = ? AND json_extract(e.event_detail, '$.messageKind') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM event a WHERE a.event_kind = 'inbox_action' AND json_extract(a.event_detail, '$.shout') = s.shout_id)
      AND NOT EXISTS (SELECT 1 FROM shout r WHERE r.shout_answers = s.shout_id)
    ORDER BY s.shout_id DESC LIMIT ?`).all(agentId, limit);
}

/**
 * Record one action on an entry addressed to this seat, if its kind allows it.
 *
 * @param {any} board
 * @param {string} agentId
 * @param {number} id the shout
 * @param {string} action
 * @returns {void}
 */
export function recordEntryAction(board, agentId, id, action) {
  const entry = board.db.prepare(`SELECT json_extract(e.event_detail, '$.messageKind') AS kind FROM event e
    WHERE e.event_kind = 'shout' AND json_extract(e.event_detail, '$.shout') = ? AND json_extract(e.event_detail, '$.to') = ?`).get(id, agentId);
  if (!entry) throw new Refused('NO_ENTRY', `#${id} is not an inbox entry addressed to ${agentId}`, 'read pullboard inbox for the entries awaiting an action');
  requireAllowedAction({ id, kind: entry.kind, action });
  atomic(board, () => logEvent(board, agentId, 'inbox_action', null, { shout: id, action }));
}
