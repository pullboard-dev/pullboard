export { IMPLIES_ENGINE } from '../logic/move/constants.js';
import { IMPLIES_ENGINE } from '../logic/move/constants.js';
/**
 * A decision names the items it changes, and each named item carries it [B29,B30,B31,N29,P6].
 *
 * An answer, a verdict or a fact can carry `implies`: the ids of other items the decision changes.
 * Each named item gets a fact citing the decision, and when the decision is superseded each gets a
 * second fact naming the new one. Both are ordinary item facts in the event log; no other store.
 *
 * Who decided always comes from the board's own record of the decision (the answer's sender, the
 * verdict's reviewer, the fact's author), never from the caller's arguments, so no relay or API
 * caller can mint a person-origin citation (P6). The only route to `by: "person"` is a real
 * person answer, which keeps its own person-channel rules.
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { COORDINATOR } from '../../../config/index.js';
import { ENGINE_VERSION } from './engine/metadata.js';
import { Refused } from '../../../kernel/index.js';



/**
 * Parse an `--implies` value into item ids, accepting `12,13` or `#12, #13`.
 *
 * @param {string | undefined} text
 * @returns {number[] | undefined}
 */
export function parseImplies(text) {
  if (text === undefined) return undefined;
  const parts = String(text).split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^#?[1-9]\d*$/u.test(part))) {
    throw new Refused('USAGE', `--implies takes item ids separated by commas, as in --implies 12,13 (saw "${text}")`);
  }
  return [...new Set(parts.map((part) => Number(part.replace('#', ''))))];
}


/**
 * Validate the implied ids before any part of the decision is written, naming the first unknown one.
 * Refuses on a board replaying an older engine, so a forged older move cannot change state.
 *
 * @param {any} board
 * @param {unknown} implies
 * @returns {number[]}
 */
export function checkImplies(board, implies) {
  if (implies === undefined || implies === null) return [];
  if (!Array.isArray(implies) || implies.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Refused('USAGE', '--implies takes item ids separated by commas, as in --implies 12,13');
  }
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (implies.length && engine < IMPLIES_ENGINE) {
    throw new Refused('ENGINE_VERSION', `a decision that implies items requires engine ${IMPLIES_ENGINE}; this board uses engine ${engine}; upgrade Pullboard before using --implies`);
  }
  for (const id of implies) {
    if (!board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(id)) {
      throw new Refused('NO_ITEM', `no item #${id} to imply; name items from pullboard list --all`);
    }
  }
  return [...new Set(implies)];
}

/** The first nonempty line of a decision's text, trimmed, as its citation reads it. */
export function firstLine(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** A short name for a decision, as the facts and `pullboard why` print it. */
export function decisionLabel(decision) {
  if (decision.source === 'answer') return `answer #${decision.id}`;
  if (decision.source === 'verdict') return `verdict on #${decision.item}`;
  return `fact ${decision.id} on #${decision.item}`;
}

/** The citation of an answer, read from its shout row. */
export function answerDecisionRef(shout) {
  return { source: 'answer', id: shout.shout_id, item: null, by: shout.shout_from, line: firstLine(shout.shout_text) };
}

/** The citation of a verdict, read from its verdict row. */
export function verdictDecisionRef(verdict) {
  const verb = verdict.verdict_decision === 'ACCEPT' ? 'accept' : 'reject';
  const note = firstLine(verdict.verdict_note);
  return { source: 'verdict', id: verdict.verdict_id, item: verdict.item_id, by: verdict.verdict_by,
    line: `${verb} ${verdict.verdict_reason}${note ? `: ${note}` : ''}` };
}

/** The citation of a fact, read from its stamped event. */
export function factDecisionRef(fact, itemId) {
  return { source: 'fact', id: fact.id, item: itemId, by: fact.by, line: firstLine(fact.text) };
}

/**
 * The seed for implied-fact ids: the sealed move id on replay, or a fresh one when no move supplies it.
 * A move id may be 80 characters, but an implied id adds a suffix and must still fit a fact id, so a
 * move id longer than 72 is replaced by a digest of itself: every replica derives the same ids.
 */
export function impliesSeed(seed) {
  if (typeof seed === 'string' && /^[A-Za-z0-9_-]{1,72}$/u.test(seed)) return seed;
  if (typeof seed === 'string' && /^[A-Za-z0-9_-]{73,80}$/u.test(seed)) return `h${createHash('sha256').update(seed).digest('base64url').slice(0, 43)}`;
  return randomUUID();
}

/**
 * Write one fact on each implied item citing the decision, stamped with the decider.
 *
 * @param {(by: string, itemId: number, detail: object) => void} log appends one fact event
 * @param {{ seed: string, decision: object, implies: number[] }} options
 */
export function writeImplied(log, { seed, decision, implies }) {
  for (const itemId of implies) {
    log(decision.by, itemId, { id: `${seed}-i${itemId}`, kind: 'note', text: `implied by ${decisionLabel(decision)} by ${decision.by}: ${decision.line}`,
      ref: null, supersedes: null, decision });
  }
}

/**
 * Tell each item the old decision implied that a new decision supersedes it, stamped with the new decider.
 *
 * @param {(by: string, itemId: number, detail: object) => void} log appends one fact event
 * @param {{ seed: string, old: object, next: object, implies: number[] }} options
 */
export function writeSuperseded(log, { seed, old, next, implies }) {
  for (const itemId of implies) {
    log(next.by, itemId, { id: `${seed}-s${itemId}`, kind: 'note',
      text: `${decisionLabel(old)} by ${old.by} is superseded by ${decisionLabel(next)} by ${next.by}: ${next.line}`,
      ref: null, supersedes: null, decision: old, supersededBy: next });
  }
}

/** True when two citations name the same decision. */
function sameDecision(left, right) {
  return Boolean(left && right) && left.source === right.source && left.id === right.id && (left.item ?? null) === (right.item ?? null);
}

/**
 * The items an earlier decision implied, read from the facts it wrote.
 *
 * @param {any} board
 * @param {object} decision
 * @returns {number[]}
 */
export function impliedItems(board, decision) {
  const rows = board.db.prepare("SELECT item_id, event_detail FROM event WHERE event_kind = 'fact' AND json_extract(event_detail, '$.decision') IS NOT NULL AND json_extract(event_detail, '$.supersededBy') IS NULL ORDER BY event_id").all();
  return [...new Set(rows.filter((row) => sameDecision(JSON.parse(row.event_detail).decision, decision)).map((row) => row.item_id))];
}

/**
 * The decisions that imply an item, newest first, each with the decision that superseded it (N29).
 *
 * @param {any[]} thread the item's facts and moves, oldest first
 * @returns {{ source: string, id: any, item: number | null, by: string, line: string, at: string, fact: string, supersededBy: object | null }[]}
 */
export function decisionsImplying(thread) {
  const facts = thread.filter((entry) => entry.type === 'fact' && entry.decision);
  return facts.filter((fact) => !fact.supersededBy)
    .map((fact) => ({ ...fact.decision, at: fact.at, fact: fact.id,
      supersededBy: facts.filter((notice) => notice.supersededBy && sameDecision(notice.decision, fact.decision)).at(-1)?.supersededBy ?? null }))
    .reverse();
}

/** One line for a decision as `pullboard why` prints it. */
export function whyLine(entry) {
  return `${entry.at}  ${decisionLabel(entry)} by ${entry.by}: ${entry.line}${entry.supersededBy ? `  (superseded by ${decisionLabel(entry.supersededBy)} by ${entry.supersededBy.by})` : ''}`;
}

/** True when this replay's engine tells implied items about supersession; older replays never did. */
export function tellsSupersession(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= IMPLIES_ENGINE;
}

/** One shout row, or a refusal naming its id. */
function shoutRow(board, id) {
  const found = board.db.prepare('SELECT * FROM shout WHERE shout_id = ?').get(id);
  if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
  return found;
}

/**
 * The earlier answer a new answer supersedes, or null; refuses anything that is not an answered
 * decision, and an agent overruling the person (P6) or another agent's answer (B30).
 *
 * @param {any} board
 * @param {number | null} supersedes
 * @param {{ from: string, person: string }} answerer who answers now, and the person's id
 * @returns {any | null}
 */
export function supersededAnswer(board, supersedes, { from, person }) {
  if (supersedes === null || supersedes === undefined) return null;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < IMPLIES_ENGINE) throw new Refused('ENGINE_VERSION', `superseding an answer requires engine ${IMPLIES_ENGINE}; this board uses engine ${engine}; upgrade Pullboard before using --supersedes`);
  if (!Number.isSafeInteger(supersedes) || supersedes < 1) throw new Refused('USAGE', 'name the answer this one supersedes by its shout id: --supersedes 12');
  const old = shoutRow(board, supersedes);
  const ask = old.shout_answers === null ? null : shoutRow(board, old.shout_answers);
  if (old.shout_decision || !ask?.shout_decision || ask.shout_request) {
    throw new Refused('NOT_A_DECISION', `shout #${supersedes} is not an answer to a decision; supersede an answer id from pullboard decisions`);
  }
  if (old.shout_from === person && from !== person) {
    throw new Refused('B26_PERSON_ANSWER', `answer #${supersedes} is the person's; only the person supersedes it: ask your coordinator to pass a new decision to the person`);
  }
  if (from !== person && from !== COORDINATOR && old.shout_from !== from) {
    throw new Refused('NOT_YOUR_DECISION', `answer #${supersedes} is ${old.shout_from}'s; only its author, the coordinator or the person supersedes it`);
  }
  return old;
}

/**
 * Cite the newest verdict on each item it implies, and tell the items the verdict before it
 * implied that this one supersedes it. Engines before IMPLIES_ENGINE replay unchanged.
 * Runs inside the verdict's transaction, so a refused id leaves no verdict behind.
 *
 * @param {any} board
 * @param {(by: string, itemId: number, detail: object) => void} log appends one fact event
 * @param {number} id the verdict's item
 * @param {{ seed?: string, implies?: number[] }} options
 */
export function tellVerdictImplications(board, log, id, { seed, implies }) {
  const named = checkImplies(board, implies);
  const [latest, previous] = board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id DESC LIMIT 2').all(id);
  const decision = verdictDecisionRef(latest);
  const ids = impliesSeed(seed);
  writeImplied(log, { seed: ids, decision, implies: named });
  if (!previous || !tellsSupersession(board)) return;
  const old = verdictDecisionRef(previous);
  writeSuperseded(log, { seed: ids, old, next: decision, implies: impliedItems(board, old) });
}

/**
 * Cite a new answer on each item it implies, and tell the items an earlier answer implied that this
 * one supersedes it. Runs inside the answer's transaction, so a refusal leaves no answer behind.
 *
 * @param {any} board
 * @param {(by: string, itemId: number, detail: object) => void} log appends one fact event
 * @param {number} answerId the new answer's shout id
 * @param {{ seed?: string, implies?: number[], supersedes?: number | null, from: string, person: string }} options
 * @returns {number} the answer's id, so the caller records and tells in one step
 */
export function tellAnswerImplications(board, log, answerId, { seed, implies, supersedes, from, person }) {
  const named = checkImplies(board, implies);
  const replaced = supersededAnswer(board, supersedes, { from, person });
  const decision = answerDecisionRef(shoutRow(board, answerId));
  const ids = impliesSeed(seed);
  writeImplied(log, { seed: ids, decision, implies: named });
  if (replaced) writeSuperseded(log, { seed: ids, old: answerDecisionRef(replaced), next: decision, implies: impliedItems(board, answerDecisionRef(replaced)) });
  return answerId;
}

/**
 * Cite a new fact on each item it implies, and tell the items the fact it supersedes implied.
 * Runs inside the fact's transaction, so a refused id leaves no fact behind.
 *
 * @param {any} board
 * @param {(by: string, itemId: number, detail: object) => void} log appends one fact event
 * @param {any} fact the new fact as the thread reads it
 * @param {{ id: number, implies?: number[], supersedes: string | null }} options its item, implied ids and the fact it corrects
 * @returns {any} the new fact
 */
export function tellFactImplications(board, log, fact, { id, implies, supersedes }) {
  const named = checkImplies(board, implies);
  const decision = factDecisionRef(fact, id);
  const seed = impliesSeed(fact.id);
  writeImplied(log, { seed, decision, implies: named });
  if (supersedes !== null && tellsSupersession(board)) {
    const row = board.db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind = 'fact' AND item_id = ? AND json_extract(event_detail, '$.id') = ?").get(id, supersedes);
    const old = factDecisionRef({ id: supersedes, by: row.event_by, text: JSON.parse(row.event_detail).text }, id);
    writeSuperseded(log, { seed, old, next: decision, implies: impliedItems(board, old) });
  }
  return fact;
}

/** The refusal for an answer to a request: a person answer, or one that names items or supersedes. */
export function requestAnswerRefusal(id, { asPerson }) {
  return asPerson
    ? new Refused('B26_PERSON_ANSWER', `requests are answered by the coordinator; run pullboard answer ${id} done or declined <reason>`)
    : new Refused('NOT_A_DECISION', `request #${id} is not a decision, so it implies and supersedes nothing; answer it with pullboard answer ${id} done or declined <reason>`);
}



/** The most fact ids one checkout remembers as shown; older ones age out first. */
const SEEN_LIMIT = 2000;

/**
 * The decision facts on the items this agent holds that its resume has not shown yet, marking them
 * shown. The record is per checkout, like resume's release notes, so each shows once (B29).
 *
 * @param {string} gitDir this checkout's own git directory
 * @param {{ item: number, facts: any[] }[]} held each held item and its thread
 * @returns {{ item: number, fact: string, text: string }[]}
 */
export function takeDecisionNotices(gitDir, held) {
  const record = join(gitDir, 'pullboard-checkout', 'decisions-seen.json');
  let seen = [];
  try { seen = JSON.parse(readFileSync(record, 'utf8')).seen ?? []; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (!Array.isArray(seen)) seen = [];
  const known = new Set(seen);
  const notices = held.flatMap(({ item, facts }) => facts
    .filter((fact) => fact.type === 'fact' && fact.decision && !known.has(fact.id))
    .map((fact) => ({ item, fact: fact.id, text: fact.text })));
  if (!notices.length) return notices;
  const next = [...seen, ...notices.map((notice) => notice.fact)].slice(-SEEN_LIMIT);
  mkdirSync(dirname(record), { recursive: true });
  const temporary = `${record}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, seen: next })}\n`);
  renameSync(temporary, record);
  return notices;
}
