import { isLaneEscalation } from "../../../../../seats/index.js";
import { leadOwnsDecision } from "../../../../../seats/index.js";
import { answerProvenance } from "../../../../../items/index.js";
import { getShout } from "../read/shouts.js";
import { PERSON } from "../query.js";
import { COORDINATION_SHOUT } from "../../../logic/board/audience.js";
import { itemShoutReader } from "../../../logic/board/audience.js";
import { shoutItemId } from "../../../../../kernel/index.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { COORDINATOR } from "../../../../../config/index.js";
import { Refused } from "../../../../../kernel/index.js";
import { requestAnswerRefusal } from "../../../../../state/index.js";
import { tellAnswerImplications } from "../../../../../state/index.js";
import { insertShout } from "../shout.js";

/**
 * Answer an open decision addressed to the caller, delivering passed-up answers to the asker (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, text: string, lanes: string[], asPerson?: boolean, channel?: 'terminal' | 'view', implies?: number[], supersedes?: number | null, impliesId?: string, origin?: string, rationale?: string }} options - implies and supersedes tell items (B29,B31); origin and rationale record where the decision came from (N29)
 * @returns {number}
 */
export function answerDecision(board, id, { agentId, text, lanes, asPerson = false, channel = 'terminal', implies, supersedes = null, impliesId, origin, rationale }) {
  return atomic(board, () => {
    const ask = getShout(board, id);
    if (ask.shout_request) {
      if (asPerson || implies?.length || supersedes !== null) throw requestAnswerRefusal(id, { asPerson });
      return insertShout(board, { from: agentId, to: ask.shout_from, text, lanes, answers: id });
    }
    if (!ask.shout_decision) throw new Refused('NOT_A_DECISION', `shout #${id} asked for no decision`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    if (asPerson && agentId !== COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `only the main checkout can answer as the person; ask your coordinator: pullboard answer ${id} "<answer>"`);
    if (asPerson && ask.shout_to !== PERSON) throw new Refused('B26_PERSON_ANSWER', `person mode answers only decisions addressed to the person; the coordinator answers this one: pullboard answer ${id} "<answer>"`);
    if (!asPerson && ask.shout_to === PERSON && agentId === COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `this decision is addressed to the person; answer from the main checkout: pullboard answer ${id} "<answer>" --as person`);
    const personAnswer = asPerson;
    const caller = personAnswer ? null : board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id = ?').get(agentId);
    const addressedItem = shoutItemId(ask.shout_to);
    const ownsDecision = ask.shout_to === agentId || ask.shout_to === caller?.agent_lane
      || (ask.shout_to === COORDINATION_SHOUT && agentId === COORDINATOR)
      || (addressedItem !== null && itemShoutReader(board.db, addressedItem, agentId));
    if (!ownsDecision && !personAnswer) {
      const lane = caller?.agent_lane ? `your ${caller.agent_lane} lane` : 'a lane you do not belong to';
      throw new Refused('NOT_YOUR_DECISION', `shout #${id} is addressed to ${ask.shout_to}, not ${lane} (agent ${agentId})`);
    }
    const from = personAnswer ? PERSON : agentId;
    const provenance = answerProvenance(board, { agentId, asPerson: personAnswer, text, origin, rationale });
    if (!personAnswer && leadOwnsDecision(board, ask, agentId)) insertShout(board, { from, to: COORDINATOR, text: `Lane decision #${id}: ${String(text).trim()}`, lanes, detail: { messageKind: 'decision' } });
    const answerId = tellAnswerImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), insertShout(board, { from, to: ask.shout_from, text, lanes, answers: id, channel, ...(addressedItem === null ? {} : { item: addressedItem }), detail: { ...(implies?.length ? { implies } : {}), ...(supersedes !== null ? { supersedes } : {}), ...(provenance ? { provenance } : {}) } }), { seed: impliesId, implies, supersedes, from, person: PERSON });
    if ((personAnswer || agentId === COORDINATOR && isLaneEscalation(board, ask)) && ask.shout_answers !== null) {
      const original = getShout(board, ask.shout_answers);
      insertShout(board, { from, to: original.shout_from, text: `${personAnswer ? 'Person' : 'Coordinator'} answered #${id}: ${String(text).trim()}`, lanes, answers: original.shout_id, channel, ...(shoutItemId(original.shout_to) === null ? {} : { item: shoutItemId(original.shout_to) }) });
    }
    return answerId;
  });
}
