import { reviewRequestClause } from '../../logic/request.js';
import { REVIEW_REQUEST_ENGINE } from '../../../../state/light.js';
import { BOARD_PROGRESS_ENGINE } from '../../../../state/index.js';
import { RIGOR_INSTRUCTIONS_ENGINE } from '../../../../state/index.js';
import { restatesBoardState } from '../../../../roadmap/index.js';
import { routeLaneMessage } from "../../../../seats/index.js";
import * as itemDecisions from "../../../../items/index.js";
import { activityNewsFlag } from "../../logic/board/activity/news.js";
import { getShout } from "./read/shouts.js";
import { PERSON } from "./query.js";
import { now } from "./query.js";
import { ITEM_SHOUT_ENGINE } from "../../../../state/light.js";
import { COORDINATION_SHOUT } from "../../logic/board/audience.js";
import { checkEvidence } from "../../logic/board/audience.js";
import { itemShoutTarget } from "../../logic/board/audience.js";
import { itemShoutReader } from "../../logic/board/audience.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { COORDINATOR } from "../../../../config/index.js";
import { compactShoutsEnabled } from "../../../../config/index.js";
import { loadConfig } from "../../../../config/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { PROOF_RUN_ENGINE } from "../../../../state/light.js";
import { refuseLongShout } from "../receipts.js";

/**
 * Insert a shout within the caller's transaction.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], item?: number, decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, news?: boolean, channel?: 'terminal' | 'view', detail?: object }} message - detail: extra event fields
 * @returns {number}
 */
export function insertShout(board, { from, to, text, lanes, item, decision = false, answers = null, evidence = null, request = false, news = false, channel = 'terminal', detail = {}, options, effects, kind, clause }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const quote = engine >= REVIEW_REQUEST_ENGINE ? reviewRequestClause(board, { from, to, item, text, kind, clause }) : null;
  if (quote) {
    text = `${text.trim()}\nBar: ${quote}`;
    refuseLongShout(text);
    detail = { ...detail, kind, clause: quote };
  }
  const validatedDecision = itemDecisions.itemDecisionDetail(board, { options, decision, item, from, effects }, { itemShoutReader }, engine);
  detail = { ...detail, ...validatedDecision };
  // inbox.keepUntilActed: the kind rides on the shout event so the inbox can name the actions it allows [C7,#8519].
  if (board.inboxKeep && kind !== undefined && detail.messageKind === undefined) detail = { ...detail, messageKind: kind };
  if (item !== undefined) {
    if (engine < ITEM_SHOUT_ENGINE) throw new Refused('ENGINE_VERSION', 'item messages require engine 93; upgrade every linked device before sending one');
    to = itemShoutTarget(board.db, item);
    // board.compactShouts (#9336): the event keeps the shout id (set in persistShout) and the thread reads the text from the shout table.
    detail = { ...detail, item, ...(compactShoutsEnabled() ? {} : { text: text.trim() }) };
  }
  const coordinationOnly = engine >= ITEM_SHOUT_ENGINE && to === 'all' && from !== COORDINATOR && from !== PERSON
    && Boolean(board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(from));
  if (coordinationOnly) to = COORDINATION_SHOUT;
  if (!text.trim()) throw new Refused('EMPTY_SHOUT', 'a shout needs text');
  if (to === from) throw new Refused('SELF_SHOUT', `a shout cannot be addressed to its sender ${from}; name another agent, a lane or all`);
  if (request && (from !== 'person' || to !== COORDINATOR || decision || answers !== null)) {
    throw new Refused('BAD_REQUEST', 'a request goes from the person to the coordinator; use the board requests endpoint with its text');
  }
  const ask = answers === null ? null : getShout(board, answers);
  const isAgent = board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(to);
  const requestReply = ask?.shout_request && to === ask.shout_from;
  if (item === undefined && !coordinationOnly && to !== 'all' && to !== PERSON && !lanes.includes(to) && !isAgent && !requestReply) {
    throw new Refused('NO_READER', `nobody reads "${to}": name a lane, an agent or all`);
  }
  if (to === PERSON && decision && from !== COORDINATOR) {
    throw new Refused('B26_PERSON_DECISION', `only the coordinator can ask the person for a decision; ask your coordinator: pullboard shout coordinator --kind question "${text.trim()}" --decision`);
  }
  let outcome = '';
  if (ask?.shout_request) {
    if (from !== COORDINATOR || !requestReply) throw new Refused('COORDINATOR_ONLY', `only the coordinator answers request #${answers}; ask the coordinator to run pullboard answer ${answers} done or declined <reason>`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ? AND shout_request_outcome != ?').get(answers, '')) {
      throw new Refused('REQUEST_CLOSED', `request #${answers} was already answered; read pullboard inbox before answering another request`);
    }
    const reply = /^(done|declined)(?:\s+([\s\S]+))?$/.exec(text.trim());
    if (!reply || (reply[1] === 'declined' && !reply[2]?.trim())) {
      throw new Refused('REQUEST_OUTCOME', `answer request #${answers} with done or declined followed by a reason: pullboard answer ${answers} done or declined <reason>`);
    }
    outcome = reply[1];
  } else if (ask && !ask.shout_decision) {
    throw new Refused('NOT_A_DECISION', `shout #${answers} asked for no decision; reply with pullboard shout`);
  }
  if (evidence) checkEvidence(board, evidence);
  const personAnswer = from === PERSON && answers !== null && !decision;
  if (personAnswer && !['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'record the person answer through the terminal or the view; run pullboard view');
  }
  return persistShout(board, { from, to, text, decision, answers, evidence, request, news, channel, detail, outcome, personAnswer, decisionRecord: validatedDecision.decisionOptions || validatedDecision.decisionEffects
    ? { ...(item === undefined ? {} : { item }),
      ...(validatedDecision.decisionOptions ? { options: validatedDecision.decisionOptions } : {}),
      ...(validatedDecision.decisionEffects ? { effects: validatedDecision.decisionEffects } : {}) } : null });
}

/**
 * Whether the board's rigor.autoDraft setting allows unproved Rigor auto-drafts (GH #26).
 * It lives here, not in the rigor cell, so rigor gains no edge to config; a missing or bad config keeps the default of drafting.
 */
export function rigorAutoDraftOn(board) {
  try { return !board.gitRoot || loadConfig(board.gitRoot).rigor?.autoDraft !== false; } catch { return true; }
}

/** Persist a validated message or a fixed internal notice inside the caller's transaction. */
export function persistShout(board, { from, to, text, decision = false, answers = null, evidence = null, request = false,
  channel = 'terminal', detail = {}, outcome = '', personAnswer = false, decisionRecord = null, news = false }) {
  const result = board.db
    .prepare(
      `INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_decision, shout_answers,
         shout_evidence_kind, shout_evidence_outcome, shout_evidence_item, shout_evidence_commit,
         shout_request, shout_request_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, text.trim(), now(board), decision ? 1 : 0, answers, evidence?.kind ?? null, evidence ? evidence.outcome.trim() : null, evidence?.item ?? null, evidence?.commit ?? null, request ? 1 : 0, outcome);
  const id = Number(result.lastInsertRowid);
  logEvent(board, from, answers === null ? (news ? 'shout_news' : 'shout') : decision ? 'pass' : 'answer', detail.item ?? null, { shout: id, to, decision: Boolean(decision), request: Boolean(request), answers, ...(outcome ? { outcome } : {}), ...(personAnswer ? { channel } : {}), ...detail });
  if (from === COORDINATOR && answers === null && (board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_INSTRUCTIONS_ENGINE) {
    if (rigorAutoDraftOn(board)) board.nativePorts.recordAutomaticRigorDrafts(board, board.lastEvent, persistShout);
  }
  itemDecisions.recordItemDecision(board, id, { decision, answers, record: decisionRecord });
  return id;
}

/**
 * Shout to a lane, an agent, `all`, or the person (B7, B25, B26). The caller passes declared lanes.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], item?: number, decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, news?: boolean, channel?: 'terminal' | 'view' }} message
 * @returns {number}
 */
export function shout(board, message) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= PROOF_RUN_ENGINE) refuseLongShout(message.text);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= BOARD_PROGRESS_ENGINE && restatesBoardState(board, message)) {
    throw new Refused('BOARD_SHOWS_THIS', 'the board shows this; read pullboard show <id> or pullboard roadmap for progress, waits, holders and idle time');
  }
  return atomic(board, () => insertShout(board, routeLaneMessage(board, { ...message,
    news: activityNewsFlag(message, board.executionEngineVersion ?? ENGINE_VERSION) }, board.executionEngineVersion ?? ENGINE_VERSION, { reviewRequests: (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_REQUEST_ENGINE })));
}
