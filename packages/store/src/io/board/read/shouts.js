import { withDerivedFamily } from "../../../../../items/light.js";
/** Read-only auxiliary projections keep the write store bounded without changing its public API [C7]. */
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { Refused } from "../../../../../kernel/index.js";
import {
  events,
  itemThread,
  itemThreads,
  listItems,
  openDecisions,
} from "../query.js";
import { dependencyValues } from "../../../../../items/index.js";
import { needsJudgement } from "../../../../../items/index.js";
import { workerInboxQuery } from "../../../logic/board/worker.js";

/**
 * One shout by its id.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function getShout(board, id) {
  const found = board.db.prepare('SELECT * FROM shout WHERE shout_id = ?').get(id);
  if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
  return found;
}

/** Read every shout in creation order without marking it read, for addressed history and exports. */
export function allShouts(board, { from = null, since = null } = {}) {
  return board.db.prepare('SELECT * FROM shout WHERE (? IS NULL OR shout_from = ?) AND (? IS NULL OR shout_at >= ?) ORDER BY shout_id').all(from, from, since, since);
}

/** Read one shout with the current open or answered state of its decision, if it is one. */
export function shoutDetails(board, id) {
  const shout = getShout(board, id);
  const answer = shout.shout_decision
    ? board.db.prepare('SELECT * FROM shout WHERE shout_answers = ? ORDER BY shout_id LIMIT 1').get(id) ?? null
    : null;
  return { ...shout, decision_state: shout.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
}

/** Read the first reply to every decision through its indexed answer key, without one query per ask. */
export function decisionAnswers(board) {
  return board.db.prepare(`SELECT reply.* FROM shout ask JOIN shout reply ON reply.shout_id=(
    SELECT first.shout_id FROM shout first WHERE first.shout_answers=ask.shout_id ORDER BY first.shout_id LIMIT 1)
    WHERE ask.shout_decision=1 ORDER BY ask.shout_id`).all();
}

/** Requests remain visible to the coordinator until a done or declined answer closes them (A2). */
export function openRequests(board) {
  return board.db.prepare(`SELECT * FROM shout ask WHERE ask.shout_request = 1
    AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id AND reply.shout_request_outcome IN ('done', 'declined'))
    ORDER BY ask.shout_id`).all();
}

/**
 * The newest unread shouts, without marking them read: `resume` shows them, `inbox` reads them.
 *
 * @param {any} board
 * @param {string} agentId
 * @param {number} [limit]
 * @returns {any[]}
 */
export function peekShouts(board, agentId, limit = 2) {
  const agent = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId));
  if (!agent) return [];
  const query = workerInboxQuery(board, agent);
  return board.db
    .prepare(`${query.sql} ORDER BY shout_id DESC LIMIT ?`)
    .all(...query.bindings, limit)
    .reverse();
}

/** Add threads to public item projections without changing their existing fields [A1,A2,B32]. */
export function projectItemThreads(board, state) {
  return { ...state, items: state.items.map((item) => ({ ...item, thread: itemThread(board, item.id) })) };
}

import { milestones } from "../../../logic/board/milestones.js";
export { milestones };

/** Return all recorded submitted heads of items still awaiting verification [V1,V17].
 * Historical heads remain unreviewed after a rejection or resubmission; current pointers also
 * cover legacy snapshots that retained the item but not its original submit event.
 * @param {any} board
 * @returns {{ item_id: number, item_title: string, item_commit: string }[]}
 */
export function unverifiedSubmissions(board) {
  const submissions = new Map();
  for (const item of listItems(board, { all: true })) {
    if (item.item_status === 'verified') continue;
    const commits = [item.item_commit, ...events(board, { itemId: item.item_id })
      .filter(event => event.event_kind === 'submit')
      .map(event => JSON.parse(event.event_detail).commit)];
    for (const commit of commits) {
      if (!/^[0-9a-f]{40,64}$/iu.test(commit ?? '')) continue;
      submissions.set(`${item.item_id}:${commit}`, { item_id: item.item_id, item_title: item.item_title, item_commit: commit });
    }
  }
  return [...submissions.values()];
}

/** Return a pending coordinator correction until a later refreeze event adopts it [V2]. */
export function pendingRefreeze(board, id) {
  const lastRefreeze = board.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS event_id FROM event WHERE item_id = ? AND (event_kind = 'refreeze' OR event_kind IN ('claim','renew') AND json_extract(event_detail, '$.adoptedCorrection') IS NOT NULL)").get(id).event_id;
  const edits = board.db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'edit' AND event_id > ? ORDER BY event_id DESC").all(id, lastRefreeze);
  const fields = new Set();
  for (const edit of edits) {
    const details = JSON.parse(edit.event_detail);
    if (details.correctedFrozen) break; // The same ordered edit adopted every earlier correction.
    for (const field of details.pendingRefreeze ?? []) if (['after', 'criterion', 'check'].includes(field)) fields.add(field);
  }
  return [...fields].sort();
}

/** Refuse a stale claim action with the exact coordinator repair command [V2]. */
export function pendingRefreezeProblem(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 8) return null;
  const fields = pendingRefreeze(board, id);
  return fields.length
    ? new Refused('PENDING_REFREEZE', `item #${id} has a pending ${fields.join(' and ')} correction; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${id}`)
    : null;
}

/**
 * Rank items by the first unfinished milestone that contains them, leaving unlisted work last.
 * A finished milestone no longer holds back later releases.
 *
 * @param {any} board
 * @returns {(entry: any) => number}
 */
export function milestonePriorities(board) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 8) return () => 0;
  const ordered = milestones(board);
  // Only whether each listed item is verified matters: one read of those ids, never a copy of every item [C7,#10795].
  const listed = [...new Set(ordered.flatMap(milestone => milestone.items.filter(id => typeof id === 'number')))];
  const verified = new Set(listed.length ? board.db.prepare(`SELECT item_id FROM item WHERE item_status='verified'
    AND item_id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)`)
    .all(JSON.stringify(listed)).map(row => row.item_id) : []);
  const priorities = new Map();
  for (const [index, milestone] of ordered.entries()) {
    const unfinished = milestone.items.some((id) => typeof id !== 'number' || !verified.has(id));
    if (!unfinished) continue;
    for (const id of milestone.items) if (!priorities.has(id)) priorities.set(id, index);
  }
  return (entry) => priorities.get(entry.item_id) ?? ordered.length;
}

/** The moves that put an item back, so only items with one of them (or an open decision) have anything to read. */
const RETURN_KINDS = new Set(['reject', 'reopen', 'release']);
/** The moves whose detail says why the work came back. */
const REFUSAL_KINDS = new Set(['reject', 'reopen', 'release']);

/** The item an open decision's shout is addressed to, or null. */
function decisionItem(ask) {
  if (Number.isInteger(ask.item)) return ask.item;
  const named = /^item:(\d+)$/u.exec(ask.shout_to ?? '');
  return named ? Number(named[1]) : null;
}

/** The text of the latest move that sent the item back, or ''. */
function latestRefusalText(thread) {
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const entry = thread[i];
    if (entry.type !== 'move' || !REFUSAL_KINDS.has(entry.kind)) continue;
    const text = entry.detail?.note ?? entry.detail?.reason;
    if (typeof text === 'string' && text !== '') return text;
  }
  return '';
}

/**
 * The needs-judgement list of a board: one entry { id, reason, refusalText, attempts } per open item whose stop reason is wall or
 * decision, in item order. Threads come from one pass over the board's events for only the open items that were returned or have an open
 * decision, not one query per item. attempts counts rejections plus refusals since the last criterion edit [C7,#11668].
 *
 * @param {any} board
 * @param {{ history?: any[], items?: any[] }} read The event list and the listed items, when the caller already holds them.
 * @param {{ stopReason: Function, stopFacts: Function }} stopRules The stop rules, loaded by the async caller (the items cell has no sync door to them).
 * @returns {{ id: number, reason: string, refusalText: string, attempts: number }[]}
 */
export function boardNeedsJudgement(board, { history = events(board), items = listItems(board, { all: true }) } = {}, { stopReason, stopFacts }) {
  const byId = new Map(items.map(item => [item.item_id, item]));
  const open = new Set(items.filter(item => item.item_status === 'open').map(item => item.item_id));
  const decided = new Set(openDecisions(board).map(decisionItem).filter(id => open.has(id)));
  const candidates = new Set(decided);
  for (const event of history) if (event.item_id !== null && open.has(event.item_id) && RETURN_KINDS.has(event.event_kind)) candidates.add(event.item_id);
  const threads = itemThreads(board, [...candidates].sort((a, b) => a - b), history);
  const returned = [];
  for (const [id, thread] of threads) {
    const openDependencies = dependencyValues(byId.get(id)).filter(dep => Number.isInteger(dep) && byId.has(dep) && !['verified', 'withdrawn'].includes(byId.get(dep).item_status));
    const facts = stopFacts(thread, { openDecision: decided.has(id), openDependencies });
    returned.push({ id, reason: stopReason(facts), refusalText: latestRefusalText(thread), attempts: facts.rejections + facts.refusals });
  }
  return needsJudgement(returned);
}
