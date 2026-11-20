import { ensureFactIdentityIndexes } from "../../../../spec/light.js";
import { missingFactIdentityIndexes } from "../../../../spec/light.js";
import { ensureGrantActivationIndex } from "../../../../state/light.js";
import { missingGrantActivationIndex } from "../../../../state/light.js";
import { ensureJobTables } from "./jobs.js";
import { JOB_INDEX_NAMES } from "./jobs.js";
import { JOB_SCHEMA_SQL } from "./jobs.js";
import { RUN_OBJECT_NAMES } from "./jobs.js";
import { RUN_SCHEMA_SQL } from "./jobs.js";
import { missingJobTables } from "./jobs.js";
import { LEDGER_SCHEMA_SQL } from "./ledger.js";
import { missingLedgerTable } from "./ledger.js";
import { GATE_HOP_SCHEMA_SQL } from "./hop.js";
import { EVENT_ARCHIVE_SCHEMA_SQL } from "./schema/archive.js";
import { missingEventArchive } from "./schema/archive.js";

/**
 * The indexes and bounded reads behind the board's hot queries [C7]. Status, list, show, next, resume,
 * health and the view read events and shouts by kind, sender, answer and recency; on a board of tens of
 * thousands of rows each of those was a full scan (openDecisions 796 ms, health's agent activity 11 s).
 */

/** Each index a hot query needs; IF NOT EXISTS lets an existing board gain them on its next open. */
const HOT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS shout_target_id ON shout (shout_to, shout_id)',
  'CREATE INDEX IF NOT EXISTS shout_answers ON shout (shout_answers)',
  'CREATE INDEX IF NOT EXISTS shout_open_decision ON shout (shout_decision, shout_to) WHERE shout_decision = 1',
  'CREATE INDEX IF NOT EXISTS shout_open_request ON shout (shout_request) WHERE shout_request = 1',
  'CREATE INDEX IF NOT EXISTS shout_evidence_item ON shout (shout_evidence_item) WHERE shout_evidence_item IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS shout_from_at ON shout (shout_from, shout_at)',
  'CREATE INDEX IF NOT EXISTS event_by_at ON event (event_by, event_at)',
  'CREATE INDEX IF NOT EXISTS event_kind_id ON event (event_kind, event_id)',
];

/**
 * Create the hot-query indexes. They index columns that migrate() adds to older boards, so this runs
 * after it, never inside the table schema.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureHotIndexes(db) {
  for (const sql of HOT_INDEXES) db.exec(sql);
  ensureAdditiveIndexes(db);
}

/**
 * The seats of one original session, by session value. Why: seatFamily's peer read matches this exact LIKE, and
 * without it SQLite walked every `a`-key on the board, about 11 ms a call on a 300,000-row board_meta [C7,#2976].
 */
const SESSION_PEERS_INDEX = 'board_meta_agent_session_value_v1';
const SESSION_PEERS_SQL = `CREATE INDEX IF NOT EXISTS ${SESSION_PEERS_INDEX} ON board_meta (meta_value)
  WHERE meta_key LIKE 'agent\\_session:%' ESCAPE '\\'`;

/** True when the session-peers index is not installed yet. */
function missingSessionPeersIndex(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(SESSION_PEERS_INDEX);
}

/**
 * The claimed-by-owner lookup the exit guard runs twice per write, once under the write lock (4.4 ms as a scan) [C7,#10876].
 * Why additive, not in SCHEMA: SCHEMA feeds the digest, so a line there read as drift on every existing board (#11000).
 */
const OWNER_STATUS_INDEX = 'item_owner_status';
const OWNER_STATUS_SQL = `CREATE INDEX IF NOT EXISTS ${OWNER_STATUS_INDEX} ON item (item_owner, item_status)`;

/** True when the claimed-by-owner index is not installed yet. */
function missingOwnerStatusIndex(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(OWNER_STATUS_INDEX);
}

/**
 * A seat's events of one kind, in order: next's cooldown and pairing reads (releases, finishes) seek them by seat and kind [C7].
 * Why: through event_by_at they read every event of the seat and filtered by kind, which grew with the seat's whole history
 * (the coordinator's 181,874 events cost next over a second at load, 20 Nov). Additive, not in SCHEMA, so no digest drift.
 */
const SEAT_KIND_INDEX = 'event_by_kind_id';
const SEAT_KIND_SQL = `CREATE INDEX IF NOT EXISTS ${SEAT_KIND_INDEX} ON event (event_by, event_kind, event_id)`;

/** True when the seat-and-kind event index is not installed yet. */
function missingSeatKindIndex(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(SEAT_KIND_INDEX);
}

/**
 * The reservation columns #9181 put into SCHEMA and ADDED_COLUMNS without a SCHEMA_VERSION bump, so every board stamped before it read as drifted (#11172).
 * Why additive, not in SCHEMA: SCHEMA and ADDED_COLUMNS feed the digest, and repairDrift repairs no column. Each is nullable, so no row is rewritten.
 */
const ADDITIVE_COLUMNS = [
  ['item', 'item_reservation_holder', 'TEXT'],
  ['item', 'item_reservation_by', 'TEXT'],
  ['item', 'item_reservation_at', 'TEXT'],
];

/** The same columns as DDL, for the shared-schema declaration a worktree compares a trunk board against. */
export const ADDITIVE_COLUMNS_SQL = ADDITIVE_COLUMNS.map(([table, column, type]) => `ALTER TABLE ${table} ADD COLUMN ${column} ${type};`).join('\n');

/** True when the board has the table and lacks one of the additive columns. */
function missingAdditiveColumns(db) {
  return ADDITIVE_COLUMNS.some(([table, column]) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    return columns.length > 0 && !columns.some(entry => entry.name === column);
  });
}

/** Add each additive column only when absent. Why public: the shared-schema declaration must know the columns a trunk board carries. */
export function ensureAdditiveColumns(db) {
  for (const [table, column, type] of ADDITIVE_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** True when the ledger table has no commit index, which the landing proof lookups read through [C7,#11191]. */
function missingLedgerCommitIndex(db) {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='test_result_commit_file'").get();
}

/** Detect the additive upgrades eligible for an owning, already-current board. */
export function missingAdditiveIndexes(db) {
  return missingAdditiveColumns(db) || missingFactIdentityIndexes(db).length > 0 || missingGrantActivationIndex(db) || missingSessionPeersIndex(db) || missingOwnerStatusIndex(db) || missingSeatKindIndex(db) || missingJobTables(db) || missingLedgerTable(db) || missingLedgerCommitIndex(db) || missingEventArchive(db);
}

/** Install only additive fact/activation upgrades, inside the opener's existing atomic restamp. */
export function ensureAdditiveIndexes(db) {
  ensureAdditiveColumns(db);
  ensureGrantActivationIndex(db);
  db.exec(SESSION_PEERS_SQL);
  db.exec(OWNER_STATUS_SQL);
  db.exec(SEAT_KIND_SQL);
  ensureJobTables(db);
  db.exec(LEDGER_SCHEMA_SQL);
  db.exec(EVENT_ARCHIVE_SCHEMA_SQL);
  // After the archive table exists, so its fact identity indexes are made too: an older board stays equal to the declared shape.
  ensureFactIdentityIndexes(db);
}

/**
 * True when a hot index, an additive index or a job table is not installed, read without the legacy hand-off check.
 * Why: a drifted board gains only CREATE IF NOT EXISTS objects, never the hand-off adoption that rewrites rows [A5].
 */
export function missingAdditiveSchema(db) {
  const installed = name => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
  return missingAdditiveColumns(db) || HOT_INDEXES.some(sql => !installed(sql.match(/EXISTS (\w+)/u)[1])) || missingFactIdentityIndexes(db).length > 0
    || missingGrantActivationIndex(db) || missingSessionPeersIndex(db) || missingOwnerStatusIndex(db) || missingSeatKindIndex(db) || !['job', 'job_step', ...JOB_INDEX_NAMES, ...RUN_OBJECT_NAMES, 'test_result', 'test_result_key', 'test_result_commit_file', 'gate_hop', 'event_archive'].every(installed);
}

/**
 * Create the hot and additive indexes, the job tables and the gate hop table, each IF NOT EXISTS, moving and deleting no row [A5].
 * Why the hop table: the fenced hop creates it on a live board, so a drifted board that has it must still match this declaration [C7,#8465].
 */
export function ensureAdditiveSchema(db) {
  ensureAdditiveColumns(db);
  for (const sql of HOT_INDEXES) db.exec(sql);
  ensureGrantActivationIndex(db);
  db.exec(SESSION_PEERS_SQL);
  db.exec(OWNER_STATUS_SQL);
  db.exec(SEAT_KIND_SQL);
  db.exec(JOB_SCHEMA_SQL);
  db.exec(RUN_SCHEMA_SQL);
  db.exec(LEDGER_SCHEMA_SQL);
  db.exec(GATE_HOP_SCHEMA_SQL);
  db.exec(EVENT_ARCHIVE_SCHEMA_SQL);
  ensureFactIdentityIndexes(db);
}

/**
 * Events of the given kinds, oldest first, read through the kind index instead of the whole log.
 *
 * @param {any} board
 * @param {string[]} kinds
 * @returns {any[]}
 */
export function eventsOfKinds(board, kinds) {
  if (!kinds.length) return [];
  return board.db.prepare(`SELECT * FROM event WHERE event_kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY event_id`).all(...kinds);
}

/** Ids of the items merged since `fromAt`, from the kind index. */
export function costLandedIds(board, fromAt) {
  return board.db.prepare("SELECT DISTINCT item_id FROM event WHERE event_kind = 'merged' AND event_at >= ? AND item_id IS NOT NULL").all(fromAt).map(row => row.item_id);
}

/** One page of the usage, shared-usage and model events after `afterId`, oldest first. */
export function costKindEvents(board, afterId, limit) {
  return board.db.prepare("SELECT * FROM event WHERE event_kind IN ('usage', 'shared-usage', 'model') AND event_id > ? ORDER BY event_id LIMIT ?").all(afterId, limit);
}

/**
 * One page of the events of one landing or review kind after `afterId`, oldest first, straight off the kind index (one
 * kind keeps the index order, so no sort). Why a scan by kind: looking each item up reads every event the item has to find its few moves, 308 ms against 52 ms for
 * 4,764 landed items on the live board [#7362].
 */
export function costMoveEvents(board, kind, afterId, limit) {
  return board.db.prepare('SELECT * FROM event WHERE event_kind = ? AND event_id > ? ORDER BY event_id LIMIT ?').all(kind, afterId, limit);
}

/** The landing and review moves of these items. */
export function costItemEvents(board, ids) {
  if (!ids.length) return [];
  return board.db.prepare(`SELECT * FROM event WHERE item_id IN (${ids.map(() => '?').join(', ')}) AND event_kind IN ('merged', 'submit', 'accept', 'reject', 'reopen')`).all(...ids);
}

/** The id, title and lane of these items. */
export function costItems(board, ids) {
  if (!ids.length) return [];
  return board.db.prepare(`SELECT item_id, item_title, item_lane FROM item WHERE item_id IN (${ids.map(() => '?').join(', ')})`).all(...ids);
}

/** The newest event id, so an unchanged board can reuse an answer. */
export function costRevision(board) {
  return board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id ?? 0;
}

/**
 * The events cost analytics reads for a window opening at `fromAt`: every usage, shared-usage and model event, plus the
 * landing and review moves of items that landed since then. Indexed by kind and item, never the whole log.
 *
 * @param {any} board
 * @param {string} fromAt ISO time the window opens
 * @returns {any[]}
 */
export function costEvents(board, fromAt) {
  const events = [];
  for (let after = 0, page = costKindEvents(board, 0, 5000); page.length; page = costKindEvents(board, after, 5000)) { events.push(...page); after = page.at(-1).event_id; }
  const ids = costLandedIds(board, fromAt);
  for (let at = 0; at < ids.length; at += 400) events.push(...costItemEvents(board, ids.slice(at, at + 400)));
  return events.sort((a, b) => a.event_id - b.event_id);
}

/**
 * Read landing evidence and only the exact submissions a failed gate names. Proposals need no
 * unrelated submission history, and a board with no failed landing needs no submission rows.
 * Keep every landing snapshot in order: later green gates/diagnostics still clear earlier reds,
 * while repeated evidence keeps the original ordering rules in submitInvariantProposals.
 */
export function submitInvariantEvents(board, config) {
  if (config.submitGate !== 'landing') return [];
  const landings = eventsOfKinds(board, ['landing_batch']);
  const needed = new Map();
  for (const event of landings) {
    const detail = JSON.parse(event.event_detail);
    for (const gate of detail.batch?.invariantEvidence?.gates ?? []) {
      if (gate.isGreen || !gate.failures.length) continue;
      for (const row of gate.submissions) needed.set(`${row.id}:${row.commit}`, row);
    }
  }
  if (!needed.size) return [];
  const submissions = [];
  const history = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC");
  const remaining = new Map();
  for (const { id, commit } of needed.values()) {
    const commits = remaining.get(id) ?? new Set();
    commits.add(commit);
    remaining.set(id, commits);
  }
  for (const [id, commits] of remaining) {
    for (const event of history.iterate(id)) {
      const detail = JSON.parse(event.event_detail);
      if (!commits.has(detail.commit) || !detail.submissionProof) continue;
      submissions.push(event);
      commits.delete(detail.commit);
      if (!commits.size) break;
    }
  }
  return [...landings, ...submissions].sort((a, b) => a.event_id - b.event_id);
}

/**
 * The newest events, newest first. The id bound states the range read, so the plan seeks from the
 * end of the log rather than scanning it.
 *
 * @param {any} board
 * @param {number} limit
 * @returns {any[]}
 */
export function recentEvents(board, limit) {
  return board.db.prepare('SELECT * FROM event WHERE event_id > 0 ORDER BY event_id DESC LIMIT ?').all(limit);
}

/**
 * The newest shouts on the board, newest first, read without marking anything read (N26), seeking
 * from the end of the table the same way as recentEvents.
 *
 * @param {any} board
 * @param {number} [limit]
 * @returns {any[]}
 */
export function recentShouts(board, limit = 40) {
  return board.db.prepare('SELECT * FROM shout WHERE shout_id > 0 ORDER BY shout_id DESC LIMIT ?').all(limit);
}

/**
 * When each agent last moved on the board, one index seek per agent.
 *
 * @param {any} board
 * @returns {Map<string, string>}
 */
export function lastMoves(board) {
  const rows = board.db.prepare('SELECT agent_id, (SELECT MAX(event_at) FROM event WHERE event_by = agent.agent_id) AS at FROM agent').all();
  return new Map(rows.filter((row) => row.at).map((row) => [row.agent_id, row.at]));
}

/**
 * The shouts the coordinator's resume reads: every decision ask and every integration evidence shout,
 * oldest first, through their partial indexes rather than the whole shout table. A UNION, because
 * SQLite uses no partial index for one arm of an OR, and the order outside it, or SQLite scans for it.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function decisionAndEvidenceShouts(board) {
  // Two indexed reads merged here: SQLite 3.53 (Node 24) plans the UNION of these as a full shout scan.
  const decisions = board.db.prepare('SELECT * FROM shout WHERE shout_decision = 1').all();
  const evidence = board.db.prepare('SELECT * FROM shout WHERE shout_evidence_item IS NOT NULL AND shout_evidence_item > 0').all();
  const byId = new Map([...decisions, ...evidence].map((row) => [row.shout_id, row]));
  return [...byId.values()].sort((a, b) => a.shout_id - b.shout_id);
}
