import { leadOwnsDecision } from "../../../../../seats/index.js";
import { getShout } from "../read/shouts.js";
import { PERSON } from "../query.js";
import { COORDINATION_SHOUT } from "../../../logic/board/audience.js";
import { shoutItemId } from "../../../../../kernel/index.js";
import { atomic } from "../event/log.js";
import { COORDINATOR } from "../../../../../config/index.js";
import { Refused } from "../../../../../kernel/index.js";
import { insertShout } from "../shout.js";

/**
 * Pass an open coordinator decision to the person with the original question and note (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, lanes: string[] }} options
 * @returns {number}
 */
export function passDecision(board, id, { agentId, note, lanes }) {
  return atomic(board, () => {
    const ask = getShout(board, id);
    const laneEscalation = leadOwnsDecision(board, ask, agentId);
    if (agentId !== COORDINATOR && !laneEscalation) throw new Refused('COORDINATOR_ONLY', 'only the coordinator or the addressed lane lead can pass a decision up');
    if (!ask.shout_decision || (!laneEscalation && ask.shout_to !== COORDINATOR && ask.shout_to !== COORDINATION_SHOUT && shoutItemId(ask.shout_to) === null)) throw new Refused('NOT_COORDINATOR_DECISION', `shout #${id} is not a decision waiting for the coordinator`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    const text = `Passed up from ${ask.shout_from}: ${ask.shout_text}\nCoordinator note: ${String(note ?? '').trim()}`;
    if (!String(note ?? '').trim()) throw new Refused('EMPTY_NOTE', 'include a note with the reason for passing this decision');
    return insertShout(board, { from: agentId, to: laneEscalation ? COORDINATOR : PERSON, text, lanes, decision: true, answers: id, detail: shoutItemId(ask.shout_to) === null ? {} : { item: shoutItemId(ask.shout_to), text } });
  });
}
