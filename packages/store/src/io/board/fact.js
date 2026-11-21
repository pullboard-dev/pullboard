import { parseDiagnosis } from '../../../../items/index.js';
import { diagnosisBrief } from '../../../../items/index.js';
import { routeOf } from '../../../../seats/index.js';
import { checkRouted } from '../../../../items/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { setItem } from '../board.js';
import { requireFactKind } from "../../../../items/index.js";
import { mainRedFact } from "../../../../items/index.js";
import { barCheckFactFields } from "../../../../verify/index.js";
import { PERSON } from "./query.js";
import { isHeld } from "./query.js";
import { current } from "./query.js";
import { itemById } from "./query.js";
import { itemThread } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { randomUUID } from 'node:crypto';
import { factIdentityExists } from "../../../../spec/index.js";
import { requireFactIdentityIndexes } from "../../../../spec/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { Refused } from "../../../../kernel/index.js";
import { requireNeverAgain } from "../../logic/board/rigor.js";
import { factReference } from "../../../../spec/index.js";
import { factFromEvent } from "../../../../state/light.js";
import { tellFactImplications } from "../../../../state/index.js";
import { postRigorNotices } from "../board.js";

const FACT_JUDGEMENTS = new Set(['decision', 'rejection', 'supersession', 'root-cause']);

/** The item's accept move with this event id, or undefined. */
function acceptMove(board, id, eventId) {
  if (typeof eventId !== 'string') return undefined;
  return itemThread(board, id).find(entry => entry.type === 'move' && entry.kind === 'accept' && String(entry.eventId) === eventId);
}

/** Whether the seat itself recorded the item's accept move with this event id: it may correct that verdict note with a superseding fact [B31,#11787]. */
function recordedAccept(board, id, eventId, agentId) {
  return acceptMove(board, id, eventId)?.by === agentId;
}

/** Whether this id names an accept move, whoever recorded it: such a supersession carries no fact decision to tell. */
function accepted(board, id, eventId) {
  return acceptMove(board, id, eventId) !== undefined;
}

/** Append a typed fact atomically; a correction never edits the original event [B29,B30,B31,B32].
 * The internal factId is set from a sealed move's identity during replay, rather than replica-local sequence ids; a never-again with its cause is the person's alone, and rigor lists it at once (#713) [D1].
 */
export function appendFact(board, id, { agentId, kind, text, ref = null, supersedes = null, answers = null, factId = randomUUID(), implies, cause = null, neverAgain = false, asPerson = false, channel = 'terminal' }) {
  if (board.readOnly) requireFactIdentityIndexes(board.db);
  return atomic(board, () => {
    const item = current(board, itemById(board, id));
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) throw new Refused('NO_AGENT', `no registered agent ${agentId}; join a worktree before appending a fact`);
    requireFactKind(board, kind);
    if (typeof text !== 'string' || !text.trim()) throw new Refused('EMPTY_FACT', 'a fact needs nonempty text; supply the observation or judgement');
    let diagnosis = null;
    if (kind === 'diagnosis') {
      if (routeOf(board, agentId) === 'light') throw new Refused('DIAGNOSIS_ROUTE', 'a mid or strong seat records the diagnosis; release with --reason DIAGNOSIS_WRONG if it is wrong');
      if (!['open', 'claimed'].includes(item.item_status) || isHeld(board, item) && item.item_owner !== agentId && agentId !== COORDINATOR) throw new Refused('DIAGNOSIS_HELD', 'diagnose open work or your own claim; ask the holder to release other work first');
      diagnosis = parseDiagnosis(text);
      checkRouted({ brief: diagnosisBrief(diagnosis), route: 'light', criterion: item.item_criterion, check: item.item_check }, board.executionEngineVersion ?? ENGINE_VERSION);
    }
    const urgency = kind === 'urgent';
    // A person's ruling on a frozen test file's new content: a decision `test-hash <path> <sha256>` recorded as the person [C7,V4].
    const ruling = kind === 'decision' && asPerson && cause === null && !neverAgain && /^test-hash \S+ [a-f0-9]{64}$/u.test(text.trim());
    if (ruling && agentId !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', `only the person rules on a frozen test file, from the main checkout: pullboard fact ${id} decision "${text.trim()}" --as person`);
    if (ruling && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'a test-hash ruling uses the person terminal or authenticated view');
    if (urgency && (!asPerson || agentId !== COORDINATOR)) throw new Refused('B26_PERSON_APPROVAL', 'only the person marks urgent work: pullboard fact <id> urgent on --as person');
    if (urgency && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'urgent marks use the person terminal or authenticated view');
    if (urgency && !['on', 'off'].includes(text)) throw new Refused('URGENT_VALUE', 'mark urgent with on or off');
    const barFields = barCheckFactFields(board, item, { agentId, kind, text, answers, supersedes });
    const ownAccept = supersedes !== null && !FACT_JUDGEMENTS.has(kind) && recordedAccept(board, id, supersedes, agentId);
    if ((FACT_JUDGEMENTS.has(kind) || supersedes !== null) && !ownAccept && agentId !== COORDINATOR && (!isHeld(board, item) || item.item_owner !== agentId)) {
      throw new Refused('FACT_JUDGEMENT', `only the item's live holder${isHeld(board, item) ? ' (' + item.item_owner + ')' : ''} or the coordinator may append a judgement or supersede a fact; append an observation or ask the coordinator`);
    }
    if (typeof factId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(factId)) throw new Refused('BAD_FACT_ID', 'a fact identity is invalid; retry with the current Pullboard engine');
    if (factIdentityExists(board.db, factId)) throw new Refused('BAD_FACT_ID', 'this fact identity is already recorded; retry the original sealed move instead of appending it again');
    if (supersedes !== null && (typeof supersedes !== 'string' || !ownAccept && !itemThread(board, id).some((entry) => entry.type === 'fact' && entry.id === supersedes || entry.type === 'move' && entry.kind === 'accept' && String(entry.eventId) === supersedes))) {
      throw new Refused('NO_FACT', `no fact or accept move ${String(supersedes)} on item #${id}; use a fact id or an accept event id from pullboard show ${id} --json`);
    }
    const binding = factReference(ref);
    if (!urgency && !ruling && (neverAgain || asPerson || cause !== null)) requireNeverAgain(id, { agentId, cause, neverAgain, asPerson, channel });
    // The row logEvent returns is this fact's own: board.lastEvent ends as the last chained row, such as a lifted hold's unhold_item [C7].
    const trigger = logEvent(board, neverAgain || urgency || ruling ? PERSON : agentId, 'fact', id, { id: factId, kind, text, ref: binding, supersedes, ...barFields, ...(neverAgain ? { cause, neverAgain: true, channel } : {}), ...(implies?.length ? { implies } : {}) });
    if (urgency) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(`item_urgent:${id}`, text);
    if (diagnosis) {
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
        .run(`item_diagnosis:${id}`, JSON.stringify({ ...diagnosis, factId, by: agentId, criterion: item.item_criterion, check: item.item_check }));
      // A strong item keeps its route and brief: the coordinator lowers it with pullboard edit, so a cold seat never claims work that needs the strong route.
      if (item.item_route !== 'strong') setItem(board, id, { item_route: 'light', item_brief: diagnosisBrief(diagnosis) });
    }
    const result = tellFactImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), factFromEvent(trigger), { id, implies, supersedes: ownAccept || accepted(board, id, supersedes) ? null : supersedes });
    if (neverAgain) postRigorNotices(board, trigger);
    return result;
  });
}

/**
 * Record a static run's known main findings on the item: one measurement fact per rule and file, each worded by the Main red fact writer.
 * Why: a static finding main also has is not the item's, and the fact keeps that on the item's thread for the reviewer [C7,#10451].
 * Why here: it joins the fact writer it calls, so the store door adds no module to every cold command (closure-budget) [C7].
 * @param {object} board The open board.
 * @param {number} id The submitting item.
 * @param {{ agentId: string, findings: { rule: string, file: string }[], main: string }} record The submitter, the knownMain findings, and main's commit.
 * @returns {object[]} The facts written, none for an empty list.
 */
export function recordKnownMainStatic(board, id, { agentId, findings, main }) {
  return findings.map(finding => appendFact(board, id, { agentId, kind: 'measurement',
    text: mainRedFact([{ file: finding.file, name: finding.rule }], `static finding, also red on main ${main.slice(0, 12)}`) }));
}
