import { ENGINE_VERSION } from '../../../../state/browser.js';
import { withDerivedFamily } from "../../../../items/light.js";
import { withDerivedFamilies } from "../../../../items/light.js";
import { effectiveItemHead } from "../../../../verify/read.js";
import { agentParent } from "../../../../seats/light.js";
export { agentParent } from "../../../../seats/light.js";
import { projectReviewFamily } from "../../../../verify/read.js";
import { withSeatPresence } from "../presence.js";
import { projectItemDecisions } from "../../../../items/light.js";
import { itemById } from "../../logic/board/item/lookup.js";
import { itemWorkInFlight } from "../../logic/red/return.js";
import { itemStage } from "../../logic/item/stage.js";
import { handoffRecord } from "../submit/handoff/records.js";
import { pulledGateRecords } from "../submit/handoff/records.js";
import {
  activityEventDetail,
  activityInterests,
  isActivityNews,
  archivedItemEvents,
  hasEventArchive,
  itemActivity,
  projectAgentActivity,
} from "../../logic/board/activity/feed.js";
export { itemById };
import { outsideSource } from "../../../../items/light.js";
import {
  COORDINATION_SHOUT,
  itemShoutReader,
  UNREAD_SHOUT_SQL,
} from "../../logic/board/audience.js";
import { shoutItemId } from "../../../../kernel/light.js";
import { workerInboxQuery } from "../../logic/board/worker.js";
/** Canonical board queries shared by reads and the synchronous write store [C7]. */
import { verdictWithdrawals } from "../../../../verify/read.js";
import { reopenCauseCorrection } from "../../../../items/light.js";
import { COORDINATOR } from "../../../../queue/light.js";
export { validateNeeds } from "../../../../queue/light.js";
import { itemFiles } from "../../../../items/light.js";
import { parseSpec } from "../../../../spec/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/browser.js";
import { Refused } from "../../../../kernel/light.js";
import { boardDataVersion } from "./read/light.js";
export { closeBoard, holdReadConnections, openBoardForRead, openBoardReadOnly, readEventLogVersion, systemClock } from "./read/snapshot.js";
export { schemaMissing, writeRefused } from "./migrate.js";
export { stats } from "../../logic/board/stats.js";
export { submitInvariantEvents } from "./indexes.js";
export { acceptedVerdict, verdictReviewProblem, verdictReads, verdictsFor } from "../../../../verify/read.js";

export const PERSON = 'person';

import { now } from "./read/light.js";
import { listItems } from "./read/light.js";
export { now, boardId, listItems, listItemsSql } from "./read/light.js";

export const REVIEW_RESERVATION_HEARTBEAT_TIMEOUT_MS = 2 * 60_000;

/**
 * True while someone holds the item under a lease that has not lapsed, or while the holder's own queued gate waits or
 * runs: that gate is the holder's work, so its claim never reads as open mid-gate (#2561).
 *
 * @param {any} board
 * @param {any} item
 * @returns {boolean}
 */
export function isHeld(board, item) {
  return item.item_status === 'claimed' && ((item.item_lease_until ?? '') > now(board) || itemWorkInFlight(board, item));
}

/**
 * The item as a reader should see it: a claim whose lease lapsed reads as open (B4).
 *
 * @param {any} board
 * @param {any} item
 * @param {string | null | undefined} reviewFamily Native joined metadata; undefined requests the ordinary lookup.
 * @returns {any}
 */
export function current(board, item, reviewFamily = undefined) {
  item = reviewFamily === undefined ? projectReviewFamily(board, item)
    : reviewFamily === null ? item : { ...item, item_review_family: reviewFamily };
  if (item.item_status !== 'claimed' || isHeld(board, item)) return { ...item };
  return { ...item, item_status: 'open', item_owner: null, item_lease_until: null };
}

import { itemCheckBaseline } from "../../logic/board/item/baseline.js";
export { itemCheckBaseline };

/** Find review releases after the current submission, optionally for one reviewer [V1,R1].
 * Older releases are ignored because a new submission starts a fresh review.
 */
export function reviewReleasesSinceSubmit(board, itemId, agentId = null) {
  const events = board.db.prepare("SELECT event_id, event_at, event_by, event_kind, event_detail FROM event WHERE item_id=? AND event_kind IN ('submit','release') ORDER BY event_id DESC")
    .all(itemId);
  const releases = [];
  for (const event of events) {
    if (event.event_kind === 'submit') return releases;
    if (event.event_by !== agentId && agentId !== null) continue;
    try {
      const detail = JSON.parse(event.event_detail);
      if (detail.review === true || detail.review === undefined) releases.push({ ...event, legacy: detail.review === undefined,
        reason: detail.reason ?? 'reason not recorded', code: detail.reasonCode ?? null });
    } catch { /* Ignore malformed legacy details rather than treating them as review releases. */ }
  }
  return releases;
}



/**
 * One item as a reader should see it.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function getItem(board, id) {
  const redirect = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_redirect:${id}`);
  if (redirect) {
    const target = JSON.parse(redirect.meta_value);
    throw new Refused('ITEM_MOVED', `item #${id} moved to ${target.destinationHandle ?? target.destinationBoardId}#${target.destinationItemId}`);
  }
  const stored = itemById(board, id);
  const pulled = pulledGateRecords(board.db, id, Date.parse(now(board))).get(id);
  const item = { ...current(board, stored), item_stage: itemStage(stored, pulled ?? handoffRecord(board.db, id) ?? null,
    Boolean(board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='merged' LIMIT 1").get(id)), now(board)) };
  if (item.item_stage === 'in the gate' && pulled?.noRunner) item.item_gate_runner = 'none';
  const effectiveHead = effectiveItemHead(board, item);
  const baseline = itemCheckBaseline(board, item);
  const source = outsideSource(board, id);
  const rehome = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`rehome_import:${id}`);
  return { ...item, ...(effectiveHead ? { item_effective_head: effectiveHead } : {}), ...(baseline ? { item_check_baseline: baseline } : {}), ...(source ? { outside: source } : {}),
    ...(rehome ? { item_rehome_import: JSON.parse(rehome.meta_value) } : {}) };
}

/** Read an item's coordinator hold, or null when it is available for claims. */
export function itemHold(board, id) {
  const item = getItem(board, id);
  return item.item_hold_reason ? {
    item_id: item.item_id, item_hold_reason: item.item_hold_reason,
    item_hold_by: item.item_hold_by, item_hold_at: item.item_hold_at,
  } : null;
}



/** Read a stored status/owner slice, excluding claims whose leases have expired rather than caching items. */
export function itemsInStatus(board, status, owner = null) {
  return board.db.prepare(`SELECT * FROM item WHERE item_status=? AND NOT EXISTS (SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)${owner === null ? '' : ' AND item_owner=?'} ORDER BY item_id DESC`)
    .all(status, ...(owner === null ? [] : [owner])).map(item => current(board, item)).filter(item => item.item_status === status);
}

/**
 * Who holds an item's review under a live lease (V15), or null. A reservation counts only while the
 * item is submitted and its lease has not run out, and a new submission starts with none.
 *
 * @param {any} board
 * @param {any} item
 * @param {Map<string, string | null> | null} [heartbeatSnapshot] - Heartbeats captured before a board write, when one is active.
 * @returns {string | null}
 */
export function reviewHolder(board, item, heartbeatSnapshot = null) {
  if (item.item_status !== 'submitted' || !item.item_review_by || (item.item_review_until ?? '') <= now(board)) return null;
  if (!heartbeatSnapshot) return item.item_review_by;
  const heartbeatAt = heartbeatSnapshot.get(item.item_review_by);
  const heartbeatAge = heartbeatAt === null || heartbeatAt === undefined ? Infinity : board.clock.now().getTime() - Date.parse(heartbeatAt);
  return heartbeatAge < REVIEW_RESERVATION_HEARTBEAT_TIMEOUT_MS ? item.item_review_by : null;
}

/** Count unreserved submissions by whether they are awaiting a first reviewer or were released [R1]. */
export function reviewQueueBreakdown(board) {
  let awaitingFirstReview = 0;
  let releasedWithoutVerdict = 0;
  const releasedItems = [];
  for (const item of itemsInStatus(board, 'submitted').filter((entry) => !reviewHolder(board, entry))) {
    const releases = reviewReleasesSinceSubmit(board, item.item_id);
    if (releases.length) {
      releasedWithoutVerdict += 1;
      releasedItems.push({ item: item.item_id, releases: releases.length, reason: releases[0].reason });
    } else awaitingFirstReview += 1;
  }
  return { awaitingFirstReview, releasedWithoutVerdict, releasedItems };
}

/** Summarize outstanding reviews using live leases and the latest submission's age [Q1,V15]. */
export function reviewQueue(board) {
  const pending = itemsInStatus(board, 'submitted');
  const holders = pending.map((item) => reviewHolder(board, item)).filter(Boolean);
  // Only the current queue needs an age. Seek each item's history, including legacy timestamps,
  // instead of grouping every submission ever made on the board.
  const submittedAt = board.db.prepare("SELECT MAX(event_at) AS at FROM event WHERE item_id=? AND event_kind='submit'");
  const oldestSubmittedAt = pending.map((item) => submittedAt.get(item.item_id).at).filter(Boolean).sort()[0] ?? null;
  return { pending: pending.length, reviewing: new Set(holders).size, reserved: holders.length, oldestSubmittedAt,
    ageMs: oldestSubmittedAt ? Math.max(0, board.clock.now().getTime() - Date.parse(oldestSubmittedAt)) : 0 };
}

/**
 * Shouts that asked for a decision nobody has answered yet, oldest first (B21). An optional
 * recipient limits the queue; an array matches any listed recipient. Without one this returns
 * every open decision for internal readers.
 *
 * @param {any} board
 * @param {string | string[]} [recipient]
 * @returns {any[]}
 */
export function openDecisions(board, recipient = null) {
  if (recipient === null) {
    return projectItemDecisions(board, board.db
      .prepare('SELECT * FROM shout ask WHERE ask.shout_decision = 1 AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id) ORDER BY ask.shout_id')
      .all());
  }
  const recipients = [...new Set(Array.isArray(recipient) ? recipient : [recipient])];
  if (!recipients.length) return [];
  const targets = [...new Set([...recipients.filter(value => typeof value === 'string'),
    ...(recipients.includes(COORDINATOR) ? [COORDINATION_SHOUT] : [])])];
  // Separate indexed seeks avoid projecting unrelated decisions. Item targets still pass the
  // exact canonical decoder and live role checks below; the SQL range grants no authority.
  const direct = targets.length ? board.db.prepare(`SELECT * FROM shout ask WHERE ask.shout_decision = 1
    AND ask.shout_to IN (${targets.map(() => '?').join(',')})
    AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id)`).all(...targets) : [];
  const itemTargets = board.db.prepare(`SELECT * FROM shout ask WHERE ask.shout_decision = 1
    AND ask.shout_to >= 'item:' AND ask.shout_to < 'item;'
    AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id)`).all();
  const candidates = [...new Map([...direct, ...itemTargets].map(ask => [ask.shout_id, ask])).values()]
    .sort((a, b) => a.shout_id - b.shout_id);
  return projectItemDecisions(board, candidates.filter((ask) => recipients.includes(ask.shout_to)
    || (ask.shout_to === COORDINATION_SHOUT && recipients.includes(COORDINATOR))
    || (shoutItemId(ask.shout_to) !== null && recipients.some((agent) => itemShoutReader(board.db, shoutItemId(ask.shout_to), agent)))));
}

/**
 * How many shouts an agent has not read, without marking them.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {number}
 */
export function unreadCount(board, agentId) {
  const agent = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId));
  if (!agent) return 0;
  const query = workerInboxQuery(board, agent, 'COUNT(*) AS total');
  const { total } = board.db.prepare(query.sql).get(...query.bindings);
  return total;
}

/**
 * The event log, oldest first, for one item or the whole board; `since` (an ISO time) and `kinds` narrow it in the query.
 *
 * @param {any} board
 * With `last`, only that many newest events come back (still oldest first), so a large board is never read whole.
 *
 * @param {{ itemId?: number, since?: string, kinds?: string[], last?: number }} [filter]
 * @returns {any[]}
 */
export function events(board, { itemId, since, kinds, last } = {}) {
  const where = [], bindings = [];
  if (itemId !== undefined && itemId !== null) { where.push('item_id = ?'); bindings.push(itemId); }
  if (since) { where.push('event_at >= ?'); bindings.push(since); }
  if (kinds?.length) { where.push(`event_kind IN (${kinds.map(() => '?').join(', ')})`); bindings.push(...kinds); }
  const filtered = `FROM event${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  // An item's archived events (#9334) read as if they never moved: hot then archive, merged in event order [#9335].
  const archived = itemId !== undefined && itemId !== null
    ? archivedItemEvents(board, itemId).filter(event => (!since || event.event_at >= since) && (!kinds?.length || kinds.includes(event.event_kind))) : [];
  const withArchive = rows => archived.length ? [...archived, ...rows].sort((a, b) => a.event_id - b.event_id) : rows;
  if (Number.isInteger(last) && last > 0) {
    const rows = board.db.prepare(`SELECT * FROM (SELECT * ${filtered} ORDER BY event_id DESC LIMIT ?) ORDER BY event_id`).all(...bindings, last);
    return withArchive(rows).slice(-last);
  }
  return withArchive(board.db.prepare(`SELECT * ${filtered} ORDER BY event_id`).all(...bindings));
}

/**
 * A shout event written under board.compactShouts holds the shout id and no text; give the text back from the shout table so the
 * thread reads the same as for an older event that kept it inline (#9336). Any other detail passes through untouched.
 */
function shoutTextBack(board, detail) {
  if (!board || detail?.text !== undefined || !Number.isInteger(detail?.shout)) return detail;
  const row = board.db.prepare('SELECT shout_text FROM shout WHERE shout_id = ?').get(detail.shout);
  return row ? { ...detail, text: row.shout_text } : detail;
}

/** One event of an item's thread, as itemThread lists it; `withdrawals` maps an accept event to the withdrawal that undid it. */
function threadEntry(event, withdrawals, board) {
  if (event.event_kind === 'fact') return { type: 'fact', ...factFromEvent(event) };
  const correction = reopenCauseCorrection(event);
  return { type: 'move', eventId: event.event_id, kind: event.event_kind, by: event.event_by,
    ...(correction ? { causeCorrection: correction } : {}),
    ...(withdrawals.has(event.event_id) ? { withdrawn: true, withdrawal: withdrawals.get(event.event_id) } : {}),
    at: event.event_at, detail: shoutTextBack(board, JSON.parse(event.event_detail)) };
}

/** Read every move and fact in append order, including superseded facts and full original text [B31,B32]. */
export function itemThread(board, id) {
  itemById(board, id);
  const withdrawals = new Map([...verdictWithdrawals(board, id).values()].map(row => [row.acceptEventId, row]));
  return itemActivity(board, id).map((event) => threadEntry(event, withdrawals, board));
}

/** The items a board-wide `main-moved` event names, as the item's own activity read matches them: integers of its `items`. */
function movedItems(event) {
  let detail;
  try { detail = JSON.parse(event.event_detail); } catch { return []; }
  const named = detail?.items;
  const values = Array.isArray(named) ? named : named !== null && typeof named === 'object' ? Object.values(named) : [named];
  return values.filter(Number.isInteger);
}

/**
 * The threads of many items at once, from the board's whole event list in order (the history a state build already
 * holds): the same entries itemThread gives each, from one pass over the events where itemThread reads the log once
 * per item and scans every board-wide main move again for each, quadratic on a board of thousands of items [C7,#8480].
 * Each id must be an item of the board. A withdrawal is looked up only for an item with a reopen that names one.
 *
 * @param {any} board
 * @param {Iterable<number>} ids
 * @param {any[]} history Every event of the board, oldest first.
 * @returns {Map<number, any[]>}
 */
export function itemThreads(board, ids, history) {
  const events = new Map([...ids].map(id => [id, []]));
  for (const event of history) {
    if (event.item_id !== null) {
      if (event.event_kind !== 'usage' && event.event_kind !== 'shared-usage') events.get(event.item_id)?.push(event);
    } else if (event.event_kind === 'main-moved') {
      for (const id of new Set(movedItems(event))) events.get(id)?.push(event);
    }
  }
  // The archiver moved a finished item's events out of the hot list the history holds; they read back in their place, as itemThread's do [#9335].
  const wanted = [...events.keys()];
  if (wanted.length > 0 && hasEventArchive(board.db)) {
    const archived = board.db.prepare("SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event_archive WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY event_id").all(JSON.stringify(wanted));
    for (const event of archived) {
      const own = events.get(event.item_id);
      if (event.event_kind === 'usage' || event.event_kind === 'shared-usage' || own.some(seen => seen.event_id === event.event_id)) continue;
      own.push(event);
      own.sort((a, b) => a.event_id - b.event_id);
    }
  }
  const threads = new Map();
  for (const [id, own] of events) {
    const withdrawals = own.some(event => event.event_kind === 'reopen' && String(event.event_detail).includes('withdrawnVerdict'))
      ? new Map([...verdictWithdrawals(board, id).values()].map(row => [row.acceptEventId, row])) : new Map();
    threads.set(id, own.map(event => threadEntry(event, withdrawals, board)));
  }
  return threads;
}

/**
 * The hold on a lane, or null.
 *
 * @param {any} board
 * @param {string} lane
 * @returns {any | null}
 */
export function laneHold(board, lane) {
  return board.db.prepare('SELECT * FROM hold WHERE hold_lane = ?').get(lane) ?? null;
}

/**
 * Every held lane.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function laneHolds(board) {
  return board.db.prepare('SELECT * FROM hold ORDER BY hold_lane').all();
}

export { rowDecisions } from "../../../../spec/light.js";

import { agentAt } from './read/light.js';
import { rowDrafts } from './read/light.js';
export { agentAt };
export { rowDrafts };

/**
 * The SQL that picks an agent's unread shouts: to it, to its lane, or to all, from anyone else.
 */
export const UNREAD_SQL = UNREAD_SHOUT_SQL;


/** Check membership without reading display-only presence sidecars inside a writer. */
export function hasAgent(board, id) {
  return typeof id === 'string' && Boolean(board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(id));
}

/** Read one seat and its model without loading every registered seat and model on the board. */
export function agentById(board, id) {
  return withModel(board, board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(id));
}

/** Whether a seat joined with --lock-lane, recorded on its join event: `next` never moves it to another lane (GH #27). */
export function agentLaneLocked(board, id) {
  return board.db.prepare("SELECT 1 FROM event WHERE event_by = ? AND event_kind = 'join' AND event_detail LIKE '%\"lockLane\":true%' LIMIT 1").get(id) !== undefined;
}

/** Read the model label kept beside other board metadata, avoiding any board-schema migration. */
export function agentModel(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_model:${id}`)?.meta_value ?? null;
}

/** Attach an agent's model to a row from the legacy stable agent table. */
export function withModel(board, agent) {
  return agent ? withSeatPresence(board, [{ ...withDerivedFamily(board, agent), agent_model: agentModel(board, agent.agent_id), agent_role: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_role:${agent.agent_id}`)?.meta_value ?? null, agent_parent_session: agentParent(board, agent.agent_id) }])[0] : agent;
}

/**
 * Every registered agent, oldest first.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function listAgents(board) {
  // Deriving every seat's family is the cost on a board of hundreds of seats; the same unchanged board reuses it.
  const version = `${boardDataVersion(board)}\0${board.executionEngineVersion ?? ENGINE_VERSION}`;
  let known = LISTED_AGENTS.get(board.db);
  if (known?.version !== version) {
    known = { version, rows: withDerivedFamilies(board, board.db.prepare(`SELECT agent.*, model.meta_value AS agent_model, parent.meta_value AS agent_parent_session FROM agent
      LEFT JOIN board_meta model ON model.meta_key='agent_model:' || agent.agent_id
      LEFT JOIN board_meta parent ON parent.meta_key='agent_parent_session:' || agent.agent_id ORDER BY agent.rowid`).all()) };
    LISTED_AGENTS.set(board.db, known);
  }
  return withSeatPresence(board, known.rows.map(row => ({ ...row })));
}

/** Remembered seat lists with derived families, by connection and the board data version they read. */
const LISTED_AGENTS = new WeakMap();


import { factFromEvent } from "../../../../state/light.js";

export const KEY = 'spec_approval_baseline';

/** Validate the exact source carried by an ordered snapshot, including the empty initial set. */
export function validBaseline(value) {
  if (!value || value.version !== 1 || typeof value.file !== 'string' || !value.file
    || !(value.anchor === null || /^[a-f0-9]{40,64}$/u.test(value.anchor)) || !Array.isArray(value.rows)) return false;
  const seen = new Set();
  return value.rows.every(row => {
    if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || typeof row.source !== 'string'
      || /[\r\n]/u.test(row.source) || seen.has(row.id)) return false;
    const parsed = parseSpec(`## Baseline\n${row.source}\n`).rows;
    seen.add(row.id);
    return parsed.length === 1 && parsed[0].id === row.id && parsed[0].text === row.text && parsed[0].status === 'approved';
  });
}

/** Compare the snapshot payload without incidental event attribution or JSON property order. */
export function canonicalBaseline(baseline) {
  return { version: 1, file: baseline.file, anchor: baseline.anchor,
    rows: baseline.rows.map(({ id, text, source }) => ({ id, text, source })) };
}

/** Distinguish a missing migration marker from an unreadable one without replacing either. */
export function specApprovalBaselineExists(board) {
  return Boolean(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(KEY)
    || board.db.prepare('SELECT 1 FROM event WHERE event_kind=? LIMIT 1').get(KEY));
}

/** Read the original snapshot without interpreting it as authenticated approval or reseeding it. */
export function specApprovalBaseline(board) {
  const stored = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(KEY);
  const events = board.db.prepare('SELECT event_by,event_detail FROM event WHERE event_kind=?').all(KEY);
  if (!stored && !events.length) return null;
  let value;
  let recorded;
  try {
    value = stored && JSON.parse(stored.meta_value);
    recorded = events.length === 1 && events[0].event_by === COORDINATOR && JSON.parse(events[0].event_detail);
  } catch { /* The same typed recovery covers malformed and incompatible records. */ }
  if (!validBaseline(value) || !validBaseline(recorded)
    || JSON.stringify(canonicalBaseline(value)) !== JSON.stringify(canonicalBaseline(recorded))) {
    throw new Refused('SPEC_APPROVAL_BASELINE', 'the approval baseline is unreadable or disagrees with its original event; restore it from a known-good board export');
  }
  return value;
}

/** Pending watches are the person's calls: one Needs-you entry each, with the evidence that proposed it. */
export function sentinelDraftNeeds(rows) {
  return rows.filter(row => row.status === 'pending').map(row => ({
    kind: 'sentinel-draft', id: `sentinel:${row.name}`, ref: row.name,
    check: row.check, directory: row.directory, every: row.every, owner: row.owner, digest: row.digest,
    text: `Sentinel draft: ${row.name} runs ${row.check} ${row.every === 'daily' || row.every === 'hourly' ? row.every : 'every ' + row.every}, reporting to ${row.owner}`,
    what: `pullboard sentinel approve ${row.name}, or decline it with --reason`, target: `sentinel:${row.name}`,
    ...(row.evidence ? { cause: row.evidence.key, evidence: row.evidence } : {}),
  }));
}

/** Read only allocated receipts; legacy events with similar names never enable command execution. */
export function sentinels(board) {
  const rows = new Map();
  const events = board.db.prepare("SELECT * FROM event WHERE event_kind IN ('sentinel-proposal','sentinel-decision','sentinel-start','sentinel-run') ORDER BY event_id").all();
  for (const event of events) {
    const detail = JSON.parse(event.event_detail);
    if (detail.engine !== BOARD_SENTINEL_ENGINE) continue;
    if (event.event_kind === 'sentinel-proposal') {
      rows.set(detail.row.name, { ...detail.row, digest: detail.digest, status: 'pending', proposedBy: event.event_by,
        proposedAt: event.event_at, evidence: detail.evidence ?? null, lastRun: null, activeRun: null, history: [] });
      continue;
    }
    const row = rows.get(detail.name);
    if (!row || row.digest !== detail.digest) continue;
    if (event.event_kind === 'sentinel-decision' && event.event_by === PERSON) {
      row.status = detail.decision === 'approve' ? 'approved' : 'declined';
      row.reason = detail.reason; row.decidedAt = event.event_at; row.activeRun = null;
    } else if (event.event_kind === 'sentinel-start') {
      row.activeRun = { id: detail.run, by: event.event_by, startedAt: event.event_at, until: detail.until };
    } else if (event.event_kind === 'sentinel-run' && row.activeRun?.id === detail.run) {
      row.lastRun = { ...detail.result, id: detail.run, at: event.event_at };
      row.history.push(row.lastRun); row.activeRun = null;
    }
  }
  return [...rows.values()];
}

/** Ask the CLI adapter for the original coordinator-housekeeping write path. */
export class ReadNeedsWrite extends Error {}

/** A matching coordinator needs no write; registration or a path change uses the full store. */
export function ensureCoordinator(board, path) {
  const existing = agentById(board, COORDINATOR);
  if (!existing || existing.agent_path !== path) throw new ReadNeedsWrite('coordinator registration or path update requires the write store');
  return COORDINATOR;
}

/**
 * Finished items that touched the same files as this one, most shared first (N21). A builder
 * starting cold reads how its neighbours were done instead of rediscovering it. File overlap, not
 * word similarity: in one real build, an item shared a source file with one of the three before it
 * in its lane 56% of the time.
 *
 * @param {any} board
 * @param {any} item
 * @param {number} [limit]
 * @returns {{ item: any, shared: string[] }[]}
 */
export function relatedItems(board, item, limit = 3) {
  const mine = new Set(itemFiles(item));
  if (!mine.size) return [];
  return listItems(board, { all: true })
    .filter((other) => other.item_id !== item.item_id && other.item_status === 'verified')
    .map((other) => ({ item: other, shared: itemFiles(other).filter((path) => mine.has(path)) }))
    .filter((entry) => entry.shared.length)
    .sort((first, second) => second.shared.length - first.shared.length || second.item.item_id - first.item.item_id)
    .slice(0, limit);
}

/** Every stamped receipt for one item, in recorded order. */
export function proofReceipts(board, itemId) {
  return board.db.prepare("SELECT event_id, event_detail FROM event WHERE item_id = ? AND event_kind = 'proof-run' ORDER BY event_id").all(itemId)
    .map(row => ({ eventId: row.event_id, ...JSON.parse(row.event_detail).receipt }));
}


/**
 * Read the adjacent batch receipt, never a per-item scan of all landing history. A pulled landing writes no batch
 * receipt, only a main-moved event naming its land job, so its base is that job's recorded main [#7751].
 */
function activityBatchBase(board, event) {
  const detail = activityEventDetail(event);
  if (!detail) return null;
  for (const [operator, order] of [['>', 'ASC'], ['<', 'DESC']]) {
    const batch = board.db.prepare(`SELECT json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END,'$.batch.id') AS id,
      json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END,'$.batch.base') AS base,
      json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END,'$.batch.tip') AS tip
      FROM event WHERE event_kind='landing_batch' AND event_id${operator}? ORDER BY event_id ${order} LIMIT 1`).get(event.event_id);
    if (batch && batch.id === detail.batch && batch.tip === detail.sha && /^[a-f0-9]{40}$/u.test(batch.base ?? '')) return batch.base;
  }
  if (typeof detail.job === 'string' && !detail.batch) {
    const base = board.db.prepare('SELECT job_base FROM job WHERE job_id = ?').get(detail.job)?.job_base;
    if (/^[a-f0-9]{40}$/u.test(base ?? '')) return base;
  }
  return null;
}

/**
 * One canonical activity history boundary for inbox readers; batch item queries rather than
 * re-reading every global landing receipt for each item. Projection never acknowledges messages.
 */
export function agentActivity(board, agentId, { after = 0, newsAfter = 0, workingFiles = [], changesForMain, prepareMainChanges, sessionStart = false, fromHead = false } = {}) {
  const agent = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_id=?').get(agentId));
  if (!agent) throw new Refused('NO_AGENT', `no agent ${agentId}; join your own worktree first`);
  if (![after, newsAfter].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Refused('BAD_ACTIVITY_CURSOR', 'activity cursors are nonnegative event ids; remove the damaged local inbox cursor and read inbox again');
  }
  // Freeze a high-water mark before any Git seam or other query; later events must remain pending.
  const { cursor, shoutCursor } = board.db.prepare(`SELECT
    (SELECT COALESCE(MAX(event_id),0) FROM event) AS cursor,
    (SELECT COALESCE(MAX(shout_id),0) FROM shout) AS shoutCursor`).get();
  // A first read starts at the head: nothing before it is owed, and reading it all is the cost (#6152).
  // Board-wide news is the session-start digest's own stream, so a fresh seat still owes itself the latest twenty; reading them
  // once through the kind index keeps the first read cheap and keeps a news shout from arriving a second time as an ordinary message.
  if (fromHead) {
    after = cursor;
    const oldest = board.db.prepare("SELECT event_id FROM event WHERE event_kind='shout_news' AND event_id<=? ORDER BY event_id DESC LIMIT 1 OFFSET 19").get(cursor);
    newsAfter = oldest ? oldest.event_id - 1 : 0;
  }
  const items = listItems(board, { all: true });
  const builds = items.filter(item => item.item_status === 'claimed' && item.item_owner === agentId);
  const observed = typeof workingFiles === 'function' ? workingFiles(builds) : workingFiles;
  const observedFiles = Array.isArray(observed) ? observed : observed.files;
  const interests = activityInterests(agent, items, { workingFiles: observedFiles, at: now(board) });
  interests.unknownWorkingFiles = !Array.isArray(observed) && observed.unknown === true;
  const wanted = [...new Set([...interests.related, ...[...interests.byId.values()]
    .filter(item => item.item_lane === agent.agent_lane).map(item => item.item_id)])];
  const query = workerInboxQuery(board, agent);
  const messages = board.db.prepare(`${query.sql} AND shout_id<=? ORDER BY shout_id`)
    .all(...query.bindings, shoutCursor);
  // Valid shout events without a deliverable message cannot contribute to the projection. Keep malformed details:
  // they produce an explicit diagnostic, and news has its own independent session cursor.
  const relevant = `AND (event_kind != 'shout' OR
    json_type(CASE WHEN json_valid(event_detail) THEN event_detail ELSE 'null' END) != 'object' OR
    json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END, '$.shout') IN (SELECT value FROM json_each(?)))`;
  const messageIds = JSON.stringify(messages.map(message => message.shout_id));
  // A fresh seat's unread messages still owe it their answers and passes, which sit before the head it starts at (#6152).
  if (fromHead && messages.length) {
    const first = board.db.prepare(`SELECT MIN(event_id) AS id FROM event WHERE event_kind IN ('shout','pass','answer') AND event_id<=?
      AND json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END, '$.shout') IN (SELECT value FROM json_each(?))`).get(cursor, messageIds).id;
    if (first !== null) after = Math.min(after, first - 1);
  }
  // A fresh seat still owes itself the typed requests filed to it and answered to it before its first read: they are open
  // obligations, not history, so the head start must not drop them (the coordinator's queue, a requester's answers) [B3,N26,C7].
  let owedFrom = Infinity;
  const owedTyped = [];
  if (fromHead) {
    const answered = new Set();
    const typed = board.db.prepare("SELECT * FROM event WHERE event_kind IN ('typed-request','typed-request-answer') AND event_id<=? ORDER BY event_id").all(cursor);
    for (const event of typed) if (event.event_kind === 'typed-request-answer') answered.add(activityEventDetail(event)?.requestId);
    for (const event of typed) {
      const detail = activityEventDetail(event);
      if (event.event_kind === 'typed-request' ? agentId === 'coordinator' && !answered.has(event.event_id) : detail?.requester === agentId) owedTyped.push(event);
    }
    if (owedTyped.length) owedFrom = owedTyped[0].event_id - 1;
  }
  const rows = new Map();
  for (const event of owedTyped) rows.set(event.event_id, event);
  // Read the new events once by id range and keep the wanted items' ones: an advanced cursor leaves a handful of rows,
  // where probing the item index once per wanted item cost tens of milliseconds on a board of a thousand items.
  const wantedIds = new Set(wanted);
  if (wantedIds.size) for (const event of board.db.prepare(`SELECT * FROM event WHERE event_id>? AND event_id<=? AND item_id IS NOT NULL ${relevant} ORDER BY event_id`).all(after, cursor, messageIds)) {
    if (wantedIds.has(event.item_id)) rows.set(event.event_id, event);
  }
  for (const event of board.db.prepare(`SELECT * FROM event WHERE event_id>? AND event_id<=?
    AND event_kind IN ('main-moved','row_decision','row_apply','row_draft','shout','shout_news','pass','answer','typed-request','typed-request-answer') ${relevant} ORDER BY event_id`).all(after, cursor, messageIds)) rows.set(event.event_id, event);
  if (sessionStart) for (const event of board.db.prepare(`SELECT * FROM event WHERE event_id>? AND event_id<=? AND event_kind='shout_news'
    ORDER BY event_id`).all(newsAfter, cursor)) rows.set(event.event_id, event);
  // News delivery uses its own cursor so ordinary inbox reads cannot consume a future session's digest.
  const possibleNewsIds = [...rows.values()].filter(event => event.event_kind === 'shout_news')
    .map(event => activityEventDetail(event)?.shout).filter(id => Number.isSafeInteger(id) && id > 0);
  for (let offset = 0; offset < possibleNewsIds.length; offset += 500) {
    const ids = possibleNewsIds.slice(offset, offset + 500);
    messages.push(...board.db.prepare(`SELECT * FROM shout WHERE shout_id IN (${ids.map(() => '?').join(',')})
      AND shout_to='all' AND shout_from IN ('coordinator','person') AND shout_decision=0
      AND shout_request=0 AND shout_answers IS NULL`).all(...ids));
  }
  const byShout = new Map(messages.map(message => [message.shout_id, message]));
  const newsIds = [...rows.values()].filter(event => isActivityNews(event, byShout.get(activityEventDetail(event)?.shout)))
    .map(event => activityEventDetail(event).shout);
  for (const event of rows.values()) if (event.event_kind === 'main-moved') event.activityBase = activityBatchBase(board, event);
  // A caller that reads Git for every landing learns them all first and can answer in one process (#3252).
  prepareMainChanges?.([...rows.values()].filter(event => event.event_kind === 'main-moved')
    .map(event => ({ commit: activityEventDetail(event)?.sha, base: event.activityBase })));
  for (const event of rows.values()) if (event.event_kind === 'row_apply') {
    const ids = activityEventDetail(event)?.events;
    event.activityRows = [];
    if (!Array.isArray(ids)) continue;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500).filter(id => Number.isSafeInteger(id) && id > 0 && id < event.event_id);
      if (chunk.length) for (const row of board.db.prepare(`SELECT * FROM event WHERE event_kind='row_decision'
        AND event_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        const id = activityEventDetail(row)?.record?.id;
        if (typeof id === 'string') event.activityRows.push(id);
      }
    }
  }
  return { ...projectAgentActivity({ agent, interests, events: [...rows.values()].toSorted((a, b) => a.event_id - b.event_id),
    shouts: messages, changesForMain, sessionStart, after: Math.min(after, owedFrom), newsAfter, cursor }), shoutCursor, newsShouts: newsIds };
}

/**
 * Every seat's last heartbeat, read before a board write opens so a reservation check inside the lock never reads the
 * private heartbeat store [C7,V15].
 *
 * @param {any} board
 * @returns {Map<string, string | null>} Seat id to its last heartbeat time, or null when it never sent one.
 */
export function heartbeatSnapshot(board) {
  return new Map(listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
}
