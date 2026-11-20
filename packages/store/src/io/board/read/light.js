/** The board reads a light consumer needs, open read-only, the board id and the item list, without heavy imports [C7,V4]. */
// Why a module of its own: query.js reaches verify, seats and items, so a light door exporting from it broke its cold-load budget.
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { fileSystemAdapter } from '../../../../../fs/index.js';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../kernel/light.js';
import { ENGINE_VERSION } from '../../../../../state/browser.js';
import { SUBMIT_HANDOFF_ENGINE } from '../../../../../state/browser.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../../state/browser.js';
import { itemWorkInFlight } from '../../../logic/red/return.js';
import { itemStage } from '../../../logic/item/stage.js';
import { handoffRecords } from '../../submit/handoff/records.js';
import { pulledGateRecords } from '../../submit/handoff/records.js';
import { withSeatPresence } from '../../presence.js';
import { withDerivedFamily } from '../../../../../items/light.js';
import { agentParent } from '../../../../../seats/light.js';

const fs = fileSystemAdapter();

/**
 * A value that changes whenever the board's data may have, for per-revision read caches [H24]: another connection's commit moves
 * SQLite's data_version, and this connection's own writes move its total_changes. It lives here so the light read loads one module less [C7].
 */
export function boardDataVersion(board) {
  return `${board.db.prepare('PRAGMA data_version').get().data_version}:${board.db.prepare('SELECT total_changes() AS n').get().n}`;
}

/** Maximum time a board connection waits for another process to release SQLite's lock. */
export const BOARD_BUSY_TIMEOUT_MS = 10_000;

/**
 * The board's time as ISO text.
 *
 * @param {any} board
 * @returns {string}
 */
export const now = (board) => board.clock.now().toISOString();

/**
 * Replace SQLite's bare lock error with the board path and elapsed wait when the wait expires.
 *
 * @param {string} file
 * @param {number} startedAt
 * @param {Error & { errcode?: number }} error
 * @param {string} [holder] - Text naming who holds the board, when the caller can read it.
 * @returns {Error}
 */
export function busyRefusal(file, startedAt, error, holder = '') {
  const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : null;
  if (sqliteCode !== 5 && error.code !== 'SQLITE_BUSY' && !/database is locked/iu.test(error.message ?? '')) return error;
  return new Refused('BOARD_BUSY', `board file ${file} remained held by another process after ${Date.now() - startedAt}ms; wait for it to finish and retry${holder}`);
}

/** How long a read keeps retrying a transient "unable to open database file" before it refuses (#3059). */
export const CANTOPEN_RETRY_MS = 5000;

/** Recognize SQLITE_CANTOPEN, including extended result codes. */
function isCantOpen(error) {
  return error?.code === 'SQLITE_CANTOPEN' || (Number.isInteger(error?.errcode) && (error.errcode & 0xff) === 14)
    || /unable to open database file/iu.test(error?.message ?? '');
}

/** Count this process's open descriptors, or null where the platform lists none. */
function openFileCount() {
  try { return fs.list('/dev/fd').length; } catch { return null; }
}

/** Open an existing board without migrations, waiting for the same locks as openBoard. The caller may pass a richer `busyError` that names the lock holder. */
export function openBoardReadOnly(file, { sleep = pauseMs, now = Date.now, budgetMs = CANTOPEN_RETRY_MS, openFiles = openFileCount, busyError = busyRefusal } = {}) {
  const startedAt = now();
  let delay = 10;
  for (;;) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}`);
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the opening error if cleanup also fails. */ }
      if (!isCantOpen(error)) throw busyError(file, startedAt, error);
      const left = budgetMs - (now() - startedAt);
      if (left <= 0) {
        const count = openFiles();
        throw new Refused('BOARD_BUSY', `board file ${file} could not be opened after ${now() - startedAt}ms of retries (${error.message}); this process has ${count ?? 'an unknown number of'} open files; wait for load to fall and retry`);
      }
      sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 500);
    }
  }
}

/** Block the thread for a short backoff, as the synchronous open cannot await. */
function pauseMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** The persistent local and relay identity of this board (A2). */
export function boardId(board) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_id').meta_value;
}

/** The item-list scope of one command (withItemSnapshot), or undefined outside one. */
const SNAPSHOT = new AsyncLocalStorage();

/** The channel the board write lock publishes on as each write transaction begins and ends (write/lock.js). */
export const BOARD_WRITE_CHANNEL = 'pullboard:board-write';

/**
 * Run `work` with one item list per board file for the whole call: listItems on a read-only connection answers each
 * filter from the list this scope read first, across connections and other processes' commits, until this process
 * begins or ends a board write, refreshItemSnapshot runs, or a remembered lease lapses [C7,N2,#12010].
 * Why: each next phase opens its own read connection, and on a live board other seats commit about once a second, so
 * one next re-read every item row many times (19.8 s of a 70 s next on a 12,000-item board).
 * `state.reads` counts the scope's table reads.
 *
 * @template T
 * @param {() => T} work
 * @param {{ reads: number }} [state]
 * @returns {T}
 */
export function withItemSnapshot(work, state = { reads: 0 }) {
  return SNAPSHOT.run({ state, generation: 0, lists: new Map() }, work);
}

/** Make the current scope read the item table again on its next listItems call; outside a scope it does nothing. */
export function refreshItemSnapshot() {
  const scope = SNAPSHOT.getStore();
  if (scope) scope.generation += 1;
}

// A write this process begins or ends may change the items, so the scope it runs in reads them again.
subscribe(BOARD_WRITE_CHANNEL, refreshItemSnapshot);

/** The remembered lists for this board: the scope's, per board file, or this connection's own outside a scope. */
function listsFor(board, scope) {
  const owner = scope ? scope.lists : LISTED, key = scope ? board.db.location?.() ?? board.db : board.db;
  if (!owner.has(key)) owner.set(key, new Map());
  return owner.get(key);
}

/** An item holds files in flight while it is claimed, submitted, or verified and not yet merged. */
const inFlightNow = item => item.item_status === 'claimed' || item.item_status === 'submitted'
  || (item.item_status === 'verified' && !item.item_merged_commit);

/**
 * Items, newest first, as a reader should see them. Closed items (verified, withdrawn) only when
 * asked. With `inFlight`, only the items holding files in flight (claimed, submitted, verified and not
 * merged), read without the board's open and landed history [C7,#10795].
 *
 * @param {any} board
 * @param {{ lane?: string, all?: boolean, inFlight?: boolean }} [filter]
 * @returns {any[]}
 */
export function listItems(board, { lane, all = false, inFlight = false } = {}) {
  const hasLane = lane !== undefined && lane !== null;
  if (inFlight) all = false;
  // One command lists the board's items many times (next did 19 times); the same unchanged board answers from memory.
  const key = `${hasLane ? lane : ''}\0${inFlight ? 'in-flight' : all}\0${board.executionEngineVersion ?? ENGINE_VERSION}`;
  // Inside withItemSnapshot a read-only connection keeps the scope's list; only this process's writes move its version.
  const scope = board.readOnly ? SNAPSHOT.getStore() : undefined;
  const version = scope ? `scope:${scope.generation}` : boardDataVersion(board);
  const lists = listsFor(board, scope);
  const remembered = lists.get(key), at = now(board);
  // Any reader's clock may reuse the list: lapsed claims stay lapsed later, and live ones hold until the first expiry.
  if (remembered && remembered.version === version && remembered.at <= at && !(remembered.expires <= at)) {
    return remembered.items.map(item => ({ ...item }));
  }
  // The open list is the all-items list without its closed items: read from a fresh remembered all-items list, not the tables again (#8432).
  if (!all) {
    const everything = lists.get(`${hasLane ? lane : ''}\0true\0${board.executionEngineVersion ?? ENGINE_VERSION}`);
    if (everything && everything.version === version && everything.at <= at && !(everything.expires <= at)) {
      const open = everything.items.filter(inFlight ? inFlightNow : item => item.item_status !== 'verified' && item.item_status !== 'withdrawn');
      lists.set(key, { at, version, expires: everything.expires, items: open.map(item => ({ ...item })) });
      return open.map(item => ({ ...item }));
    }
  }
  if (scope) scope.state.reads += 1;
  const rows = board.db.prepare(listItemsSql({ all, hasLane, inFlight })).all(...(hasLane ? [lane] : []));
  // One copy per row, as current() would make it: a thousand-item board lists its items many times per command.
  const expectedBuilds = (board.executionEngineVersion ?? ENGINE_VERSION) >= EXPECTED_BUILD_ENGINE;
  // Copying named columns is several times faster than rest-destructuring SQLite's null-prototype rows (#2511).
  const columns = rows.length ? Object.keys(rows[0]).filter(key => !['imported_rehome', 'review_family', 'review_policy', 'expected_build', 'landed'].includes(key)) : [];
  // Every item's hand-off record in one read of the job tables, where the record lives [C7].
  const records = handoffRecords(board.db, { live: true });
  const pulled = pulledGateRecords(board.db, null, Date.parse(at));
  const normalized = rows.map((row) => {
    const item = {}, imported = row.imported_rehome, family = row.review_family, expected = row.expected_build;
    for (const key of columns) item[key] = row[key];
    if (family !== null) item.item_review_family = family;
    // Labels read these two fields; the level is the route, and strict review is a stored policy with a review family or the sensitive flag (verify is not imported here).
    item.item_level = item.item_route;
    if (family !== null || strictPolicy(row.review_policy)) item.item_review_tier = 'strict';
    item.item_stage = itemStage(item, pulled.get(item.item_id) ?? records.get(item.item_id) ?? null, Boolean(row.landed), at);
    if (item.item_stage === 'in the gate' && pulled.get(item.item_id)?.noRunner) item.item_gate_runner = 'none';
    // A claim whose lease lapsed reads as open (B4) unless its own gate is in flight, exactly as isHeld() reads it (#3121).
    if (item.item_status === 'claimed' && !((item.item_lease_until ?? '') > at) && !itemWorkInFlight(board, item)) {
      item.item_status = 'open'; item.item_owner = null; item.item_lease_until = null;
    }
    if (expectedBuilds && expected !== null) item.item_expected_build_minutes = JSON.parse(expected);
    if (imported) item.item_rehome_import = JSON.parse(imported);
    return item;
  });
  // A claim whose lease lapsed reads as open above, so it leaves the in-flight list exactly as it leaves the all-items one.
  const items = inFlight ? normalized.filter(inFlightNow) : normalized;
  // A held claim reads as open once its lease passes, so the remembered list lasts only until the first future lease
  // ends; a lapsed claim held by its gate changes only with the gate's board_meta write, which moves the data version.
  const expires = items.filter(item => item.item_status === 'claimed' && (item.item_lease_until ?? '') > at).map(item => item.item_lease_until).sort()[0];
  lists.set(key, { at, version, expires, items: items.map(item => ({ ...item })) });
  return items;
}

/** Whether a stored review policy names a review family or marks the item sensitive; an unreadable policy is not strict. */
function strictPolicy(stored) {
  if (stored === null || stored === undefined) return false;
  try {
    const policy = JSON.parse(stored);
    return policy?.sensitive === true || Boolean(policy?.reviewFamily);
  } catch { return false; }
}

/**
 * The SQL that lists items, with each item's landed flag read from one scan of the merged events.
 *
 * Why: a correlated EXISTS per item walked that item's whole event history to find a merged event, so the
 * all-items list of a 3,800-item board made thousands of scattered event reads and next ran past its routing
 * budget on a cold board [#3848]. The merged events are read once, through the event kind index.
 *
 * @param {{ all: boolean, hasLane: boolean, inFlight?: boolean }} filter
 * @returns {string}
 */
export function listItemsSql({ all, hasLane, inFlight = false }) {
  const scope = inFlight ? "(item_status IN ('claimed','submitted') OR (item_status='verified' AND COALESCE(item_merged_commit,'')=''))"
    : all ? '1' : "item_status NOT IN ('verified','withdrawn')";
  return `SELECT item.*, imported.meta_value AS imported_rehome, family.meta_value AS review_family, policy.meta_value AS review_policy, expected.meta_value AS expected_build,
      item.item_id IN (SELECT item_id FROM event WHERE event_kind='merged') AS landed
      FROM item LEFT JOIN board_meta imported ON imported.meta_key='rehome_import:' || item.item_id
      LEFT JOIN board_meta family ON family.meta_key='item_review_family:' || item.item_id
      LEFT JOIN board_meta policy ON policy.meta_key='review_independence:' || item.item_id
      LEFT JOIN board_meta expected ON expected.meta_key='item_expected_build_minutes:' || item.item_id
      WHERE NOT EXISTS (SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)
      AND ${scope}${hasLane ? ' AND item_lane=?' : ''} ORDER BY item_id DESC`;
}

/** Remembered item lists by connection and filter; each entry names the board data version it read. */
const LISTED = new WeakMap();

/** The board's drafted spec rows, empty when none were drafted. */
export function rowDrafts(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('row_drafts');
  return row ? JSON.parse(row.meta_value) : [];
}

/** The agent registered for a worktree path, with its model, parent session and presence, if any. */
export function agentAt(board, path) {
  const agent = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_path = ?').get(path));
  if (!agent) return agent;
  const model = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_model:${agent.agent_id}`)?.meta_value ?? null;
  const role = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_role:${agent.agent_id}`)?.meta_value ?? null;
  return withSeatPresence(board, [{ ...agent, agent_model: model, agent_role: role, agent_parent_session: agentParent(board, agent.agent_id) }])[0];
}

/** The board's time source and a snapshot over an open read-only connection, with the native engine thresholds [C7]. */
export const systemClock = { now: () => new Date() };

/** Attach the native read-only engine thresholds to an existing observation snapshot. */
export function readBoardSnapshot(db, clock = systemClock) {
  return { db, clock, enginePorts: Object.freeze({ submitHandoffEngines }) };
}

/** Supply exact discovered engine thresholds to read-only projections. */
function submitHandoffEngines() { return { current: ENGINE_VERSION, handoff: SUBMIT_HANDOFF_ENGINE }; }

/**
 * Whether the board file at `file` holds a verified item no merge has landed, or may (an unreadable board answers true).
 * Why: the post-command landing wake loads the landing package only when something could be waiting to land [C7].
 *
 * @param {string} file
 * @returns {boolean}
 */
export function landingMayWait(file) {
  let db;
  // No board file means nothing was ever accepted here.
  if (!fs.exists(file)) return false;
  try {
    db = openBoardReadOnly(file);
    return db.prepare("SELECT 1 AS waiting FROM item WHERE item_status = 'verified' AND (item_merged_commit IS NULL OR item_merged_commit = '') LIMIT 1").get() !== undefined;
  } catch { return true; } finally { try { db?.close(); } catch { /* Nothing more to release. */ } }
}
