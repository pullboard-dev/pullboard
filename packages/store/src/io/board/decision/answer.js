import { isLaneEscalation } from "../../../../../seats/index.js";
import { leadOwnsDecision } from "../../../../../seats/index.js";
import { answerProvenance } from "../../../../../items/index.js";
import { getShout } from "../read/shouts.js";
import { PERSON } from "../query.js";
import { openDecisions } from "../query.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { ASK_CLOSE_ENGINE } from "../../../../../state/index.js";
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
import { persistShout } from "../shout.js";
import { TYPED_REQUEST_CAUSES } from "../../requests.js";

/**
 * Answer an open decision addressed to the caller, delivering passed-up answers to the asker (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, text: string, lanes: string[], asPerson?: boolean, channel?: 'terminal' | 'view', implies?: number[], supersedes?: number | null, impliesId?: string, origin?: string, rationale?: string, cause?: string }} options - implies and supersedes tell items (B29,B31); origin and rationale record where the decision came from (N29); cause is one key of TYPED_REQUEST_CAUSES
 * @returns {number}
 */
export function answerDecision(board, id, { agentId, text, lanes, asPerson = false, channel = 'terminal', implies, supersedes = null, impliesId, origin, rationale, cause }) {
  return atomic(board, () => {
    if (cause !== undefined && !TYPED_REQUEST_CAUSES.includes(cause)) throw new Refused('RULING_CAUSE', `a ruling cause is one of ${TYPED_REQUEST_CAUSES.join(', ')}`);
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
    const answerId = tellAnswerImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), insertShout(board, { from, to: ask.shout_from, text, lanes, answers: id, channel, ...(addressedItem === null ? {} : { item: addressedItem }), detail: { ...(implies?.length ? { implies } : {}), ...(supersedes !== null ? { supersedes } : {}), ...(provenance ? { provenance } : {}), ...(cause === undefined ? {} : { cause }) } }), { seed: impliesId, implies, supersedes, from, person: PERSON });
    if ((personAnswer || agentId === COORDINATOR && isLaneEscalation(board, ask)) && ask.shout_answers !== null) {
      const original = getShout(board, ask.shout_answers);
      insertShout(board, { from, to: original.shout_from, text: `${personAnswer ? 'Person' : 'Coordinator'} answered #${id}: ${String(text).trim()}`, lanes, answers: original.shout_id, channel, ...(shoutItemId(original.shout_to) === null ? {} : { item: shoutItemId(original.shout_to) }) });
    }
    return answerId;
  });
}

/**
 * Every ruling recorded under one cause key, newest first: the answers answerDecision wrote with that cause (#1444).
 *
 * @param {any} board
 * @param {string} cause - one key of TYPED_REQUEST_CAUSES
 * @returns {{ shout: number, text: string, answerer: string, at: string }[]}
 */
export function rulingsByCause(board, cause) {
  if (!TYPED_REQUEST_CAUSES.includes(cause)) throw new Refused("RULING_CAUSE", `a ruling cause is one of ${TYPED_REQUEST_CAUSES.join(", ")}`);
  return board.db.prepare(`SELECT reply.shout_id AS shout, reply.shout_text AS text, reply.shout_from AS answerer, reply.shout_at AS at
    FROM event JOIN shout reply ON reply.shout_id = json_extract(event.event_detail, '$.shout')
    WHERE event.event_kind = 'answer' AND json_extract(event.event_detail, '$.cause') = ?
    ORDER BY reply.shout_id DESC`).all(cause);
}

/** The item an open ask is about: the item it was addressed to, the item its decision record names, or the #id its text opens with. */
export function askItem(ask) {
  const addressed = shoutItemId(ask.shout_to);
  if (addressed !== null) return addressed;
  if (Number.isSafeInteger(ask.item)) return ask.item;
  const lead = /^(?:[\w.-]+: )?#(\d+)\b/u.exec(ask.shout_text ?? '');
  return lead ? Number(lead[1]) : null;
}

/** Why an item no longer needs its asks, or null while it is still live work. */
function finishedReason(item) {
  if (item.item_merged_commit) return 'landed';
  if (item.item_status === 'withdrawn') return `withdrawn: ${item.item_withdrawn_reason ?? ''}`.trim();
  return null;
}

/** Answer each listed open ask with the reason, in the caller's transaction, through the ordinary answer event. */
function closeAsks(board, asks, agentId, reasonOf) {
  const closed = [];
  for (const ask of asks) {
    const reason = reasonOf(ask);
    if (!reason) continue;
    persistShout(board, { from: agentId, to: ask.shout_from, text: `Closed: #${askItem(ask)} ${reason}`, answers: ask.shout_id,
      detail: { item: askItem(ask), closed: reason.split(':')[0] } });
    closed.push(ask.shout_id);
  }
  return closed;
}

/**
 * Close every open ask on one item that just landed or was withdrawn, with that reason, so openDecisions never lists an ask on finished work.
 * It does nothing on a board below the engine that introduced it, so older logs replay as they were written [B21,C7,H16].
 */
export function closeItemAsks(board, id, { agentId = COORDINATOR, reason }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ASK_CLOSE_ENGINE) return [];
  return atomic(board, () => closeAsks(board, openDecisions(board).filter(ask => askItem(ask) === id), agentId, () => reason));
}

/**
 * One idempotent sweep for asks already open on items that landed or were withdrawn: each closes once with that
 * reason and a second run finds nothing left to close. The scheduled sentinel sweep runs it [B21,C7,H16].
 */
export function closeFinishedAsks(board, { agentId = COORDINATOR } = {}) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ASK_CLOSE_ENGINE) return [];
  return atomic(board, () => {
    const found = new Map();
    const asks = openDecisions(board);
    const items = new Map();
    for (const ask of asks) {
      const id = askItem(ask);
      if (id === null) continue;
      if (!items.has(id)) items.set(id, board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id) ?? null);
      const item = items.get(id);
      const reason = item ? finishedReason(item) : null;
      if (reason) found.set(ask.shout_id, reason);
    }
    return closeAsks(board, asks, agentId, ask => found.get(ask.shout_id));
  });
}
