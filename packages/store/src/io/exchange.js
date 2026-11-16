import { beginImmediateQueued } from './board/busy.js';
import { ensureGateHopTable } from "./board/hop.js";
import { blobDirOf } from "../../../jobs/index.js";
import { parseStub } from "../../../jobs/index.js";
import { readBlob } from "../../../jobs/index.js";
import { withDerivedFamilies } from "../../../items/index.js";
import { suspendStoreGuards } from "./board/guards.js";
import { AGENT_GRANT_ENGINE } from "../../../state/light.js";
import { MACHINE } from "../../../state/light.js";
import { LANDING_LOCAL_PREFIX } from "../logic/board/landing/local.js";
import { PROOF_COUNTER_PREFIX } from "../../../verify/index.js";
import { FAMILY_RECORD_PREFIX } from "../../../items/index.js";
import { warmFamilyProjection } from "../../../items/index.js";
import { exportedMeta } from "../logic/board/authority.js";
import { rebuildProofCounters } from "../../../verify/index.js";
import { importSeatObservations } from "./presence.js";
import {
  beginBoardWrite,
  finishBoardWrite,
  prepareBoardWriteIdentity,
  prepareBoardWriteMarker,
  discardBoardWriteMarker,
} from "./board/write/lock.js";
/**
 * Export and import whole board files (A7), including their AUTOINCREMENT counters, so a copy can
 * continue producing the same ids after its rows are restored.
 */
import { createHash } from 'node:crypto';
import { jsonChunks } from './chunks.js';
import { Refused } from "../../../kernel/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import {
  EVENT_LOG_VERSION,
  SIGNED_EVENT_LOG_VERSION,
  specApprovalBaseline,
} from "./board.js";

const VERSION = 1;

/**
 * Quote a SQLite identifier read from the database or a validated document.
 * @param {string} name
 * @returns {string}
 */
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Names of the board's data tables, with sqlite_sequence last so imported counters remain exact.
 * @param {any} db
 * @returns {string[]}
 */
function tableNames(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()) names.push('sqlite_sequence');
  return names;
}

/**
 * The columns in a board table, in their declared order.
 * @param {any} db
 * @param {string} table
 * @returns {string[]}
 */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(({ name }) => name);
}

/**
 * Every job_step row with each blob stub replaced by the payload it stands for.
 *
 * Why: an export or relay snapshot must carry what a reader needs, and the blob store is a local file beside the board.
 * A stub whose blob was pruned stays a stub: its body is derived data that the importing board produces again.
 */
function jobStepRows(db) {
  const dir = blobDirOf(db);
  return db.prepare('SELECT * FROM job_step ORDER BY rowid').all().map(row => {
    const stub = parseStub(row.job_step_payload);
    const body = stub ? readBlob(dir, stub.blob) : null;
    return body === null ? row : { ...row, job_step_payload: body };
  });
}

/** Read native rows without fetching large local proof projections into an export or digest. */
function nativeRows(db, table) {
  if (table === 'job_step') return jobStepRows(db);
  if (table === 'board_meta') return db.prepare('SELECT * FROM board_meta WHERE (meta_key < ? OR meta_key >= ?) AND meta_key NOT GLOB ? AND meta_key NOT GLOB ? ORDER BY rowid')
    .all(PROOF_COUNTER_PREFIX, 'local:proof-stats;', LANDING_LOCAL_PREFIX + '*', FAMILY_RECORD_PREFIX + '*');
  return db.prepare(`SELECT * FROM ${identifier(table)} ORDER BY ${table === 'sqlite_sequence' ? 'name' : 'rowid'}`).all();
}

/**
 * Board tables an export may leave out; a missing one imports as empty [C7].
 *
 * Why: job, job_step, test_result, gate_hop and event_archive are an additive upgrade (board-jobs-schema.js), so a board gains them on open while
 * exports made before or without them never list them. Every other table still has to match exactly.
 */
const ADDITIVE_TABLES = new Set(['job', 'job_step', 'test_result', 'run', 'gate_hop', 'event_archive']);

/**
 * Read every exported table's rows, leaving out an additive table that holds no rows, and its counter [C7].
 *
 * Why: an older release's importer refuses tables it does not know, so an ordinary board with no jobs exports
 * without them and still imports there; a board that holds job rows keeps them. Export and the relay
 * checkpoint digest both read through here, so the two always see the same document.
 * @param {any} db
 * @param {string[]} names
 * @returns {Record<string, any[]>}
 */
function exportedTables(db, names) {
  const tables = Object.fromEntries(names.map((table) => [table, nativeRows(db, table)]));
  const omitted = new Set([...ADDITIVE_TABLES].filter((table) => Array.isArray(tables[table]) && tables[table].length === 0));
  for (const table of omitted) delete tables[table];
  if (omitted.size && Array.isArray(tables.sqlite_sequence)) {
    tables.sqlite_sequence = tables.sqlite_sequence.filter(({ name }) => !omitted.has(name));
  }
  return tables;
}

/** Require the real phase provider at the native or raw-database composition root. */
function exportPorts(board, supplied) {
  const ports = board.nativePorts ?? supplied;
  if (typeof ports?.beginCommandPhase !== 'function') {
    throw new TypeError('exportBoard needs beginCommandPhase');
  }
  return { beginCommandPhase: ports.beginCommandPhase, exportedMeta: ports.exportedMeta ?? exportedMeta };
}

/**
 * Capture every board table and row in the stable v1 document format.
 * @param {{ db: any }} board
 * @returns {{ version: number, tables: Record<string, any[]> }}
 */
export function exportBoard(board, ports) {
  ports = exportPorts(board, ports);
  const finishPhase = ports.beginCommandPhase('local-export');
  try {
    const db = board.db;
    db.exec('BEGIN DEFERRED');
    try {
      const tables = exportedTables(db, tableNames(db));
      db.exec('COMMIT');
      // The pinned relay key stays with this board file; an export never carries it to another [E22].
      tables.board_meta = ports.exportedMeta(tables.board_meta ?? []);
      return { version: VERSION, tables };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { finishPhase(); }
}

/** Hash semantic native state while excluding only per-agent inbox read cursors. */
export function semanticBoardDigest(document) {
  const tables = document?.tables;
  if (!tables || !Array.isArray(tables.agent)) throw new TypeError('semantic board digest needs exported agent rows');
  const normalized = {
    ...document,
    tables: {
      ...tables,
      ...(Array.isArray(tables.board_meta) ? { board_meta: tables.board_meta.filter(row => !row.meta_key.startsWith(PROOF_COUNTER_PREFIX) && !row.meta_key.startsWith(LANDING_LOCAL_PREFIX) && !row.meta_key.startsWith(FAMILY_RECORD_PREFIX)) } : {}),
      agent: tables.agent.map(({ agent_last_shout_id, ...row }) => row),
    },
  };
  const hash = createHash('sha256');
  for (const piece of jsonChunks(normalized)) hash.update(piece);
  return hash.digest('hex');
}

/** Recognize only nonnegative SQLite-safe inbox cursors for monotonic checkpoint preservation. */
function validReadCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The rows a document supplies for a board table, or none for an additive table the export left out.
 * @param {any} document
 * @param {string} table
 * @returns {any}
 */
function suppliedRows(document, table) {
  if (ADDITIVE_TABLES.has(table) && !Object.hasOwn(document.tables, table)) return [];
  return document.tables[table];
}

/**
 * Validate the document shape against the open board's schema before changing any rows.
 * @param {any} db
 * @param {any} document
 * @param {string[]} names
 */
function validateDocument(db, document, names) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== VERSION) {
    throw new Refused('IMPORT_VERSION', `expected board export version ${VERSION}; export it again with this pullboard version`);
  }
  if (!document.tables || typeof document.tables !== 'object' || Array.isArray(document.tables)) {
    throw new Refused('IMPORT_FORMAT', 'the export needs a tables object; use pullboard export to make one');
  }
  const supplied = Object.keys(document.tables).sort();
  const expected = names.filter((table) => !ADDITIVE_TABLES.has(table) || Object.hasOwn(document.tables, table)).sort();
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw new Refused('IMPORT_SCHEMA', `the export tables do not match this board; export and import with the same pullboard version`);
  }
  for (const table of names) {
    const columns = columnsOf(db, table);
    const rows = suppliedRows(document, table);
    if (!Array.isArray(rows)) throw new Refused('IMPORT_FORMAT', `table ${table} must contain an array of rows; export it again`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns].sort())) {
        throw new Refused('IMPORT_SCHEMA', `a ${table} row does not have exactly its board columns; export it again`);
      }
    }
  }
  // An item in a status the lifecycle never declared is refused before anything is inserted: the restore suspends the
  // board's own triggers, so this is the only place that can stop it (SM15).
  const declared = MACHINE.states.map((state) => state.id);
  const unknown = suppliedRows(document, 'item').find((row) => !declared.includes(row.item_status));
  if (unknown) {
    throw new Refused('UNDECLARED_STATE', `item #${unknown.item_id} has status ${JSON.stringify(unknown.item_status)}; an item is ${declared.join(', ')}, so nothing was imported`,
      'export the board again with the pullboard version that wrote this file');
  }
  const eventLog = document.tables.board_meta.find(({ meta_key }) => meta_key === 'event_log_version');
  const eventLogVersion = eventLog && /^(?:0|[1-9]\d*)$/u.test(eventLog.meta_value) ? Number(eventLog.meta_value) : eventLog ? NaN : 0;
  if (!Number.isSafeInteger(eventLogVersion) || eventLogVersion < 0) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${eventLog?.meta_value ?? 'missing'} in this export is invalid; export it again or upgrade pullboard`);
  }
  if (eventLogVersion > Math.max(EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION)) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${eventLogVersion} in this export is newer than this pullboard version ${SIGNED_EVENT_LOG_VERSION}; upgrade pullboard to read it`);
  }
}

/** Only the generated identity is disposable when restoring a fresh board (A2, A7). */
function hasOnlyIdentity(db, { baseline = false } = {}) {
  const rows = nativeRows(db, 'board_meta');
  const identity = rows.find((row) => row.meta_key === 'board_id');
  const eventLog = rows.find((row) => row.meta_key === 'event_log_version');
  return /^[0-9a-f]{32}$/.test(identity?.meta_value ?? '')
    && rows.length === (eventLog ? 2 : 1) + (baseline ? 1 : 0)
    && rows.every((row) => row.meta_key === 'board_id' || row.meta_key === 'event_log_version' || baseline && row.meta_key === 'spec_approval_baseline');
}

/** True only for the coordinator registration and join event that `pullboard init` creates. */
function hasOnlyInitCoordinator(db, names) {
  let baseline;
  try { baseline = specApprovalBaseline({ db }); }
  catch (error) { if (!(error instanceof Refused)) throw error; return false; }
  if (!names.includes('sqlite_sequence') || !hasOnlyIdentity(db, { baseline: Boolean(baseline) })) return false;
  const agents = withDerivedFamilies({ db }, db.prepare('SELECT * FROM agent').all());
  const events = db.prepare('SELECT * FROM event ORDER BY event_id').all();
  const sequence = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();
  if (agents.length !== 1 || events.length !== (baseline ? 2 : 1) || sequence.length !== 1) return false;
  if (baseline && (events[1].event_id !== 2 || events[1].event_by !== 'coordinator'
    || events[1].event_kind !== 'spec_approval_baseline' || events[1].item_id !== null)) return false;
  const [agent] = agents;
  const [event] = events;
  if (
    agent.agent_id !== 'coordinator'
    || agent.agent_lane !== 'coordinator'
    || agent.agent_route !== 'strong'
    || agent.agent_last_shout_id !== 0
    || !agent.agent_path
    || event.event_id !== 1
    || event.event_by !== 'coordinator'
    || event.event_kind !== 'join'
    || event.item_id !== null
    || sequence[0].name !== 'event'
    || sequence[0].seq !== events.length
  ) return false;
  try {
    const detail = JSON.parse(event.event_detail);
    if (detail.model !== undefined && detail.model !== 'unknown') return false;
    delete detail.model;
    if (detail.grantEngine !== undefined && detail.grantEngine !== AGENT_GRANT_ENGINE) return false;
    delete detail.grantEngine;
    // Init records an unknown coordinator family; a declared family is retained history.
    if (Object.hasOwn(detail, 'family') && detail.family !== null) return false;
    delete detail.family;
    if (JSON.stringify(detail) !== JSON.stringify({ lane: 'coordinator' })) return false;
  } catch {
    return false;
  }
  return names
    .filter((table) => table !== 'agent' && table !== 'event' && table !== 'sqlite_sequence' && table !== 'board_meta')
    .every((table) => !db.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get());
}

/** Share the exact disposable init shape with pairing before it consumes a one-use code. */
export function isInitialBoard(board) {
  return hasOnlyInitCoordinator(board.db, tableNames(board.db));
}

/**
 * Restore a v1 export only into an empty board, atomically, while briefly allowing historical item
 * states to be inserted before restoring the board's declared lifecycle triggers.
 * @param {{ db: any }} board
 * @param {any} document
 * @returns {{ tables: string[] }}
 */
export function importBoard(board, document) {
  const result = restoreDocument(board, document);
  importSeatObservations(board, document?.presentation?.state?.agents);
  return result;
}

/**
 * Restore an authenticated, newer checkpoint of this same relay board, preserving receipts.
 * Ordinary CLI imports still require an empty board; only the ordered replica uses this path.
 */
export function restoreRelaySnapshot(board, document, sequence, expectedNativeDigest = null) {
  validateDocument(board.db, document, tableNames(board.db));
  const meta = new Map(document.tables.board_meta.map((row) => [row.meta_key, row.meta_value]));
  const current = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('board_id')?.meta_value;
  const cursor = Number(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_applied_sequence')?.meta_value ?? 0);
  if (meta.get('board_id') !== current || !Number.isSafeInteger(sequence) || sequence < cursor || String(sequence) !== meta.get('relay_applied_sequence')) {
    throw new Refused('RELAY_SNAPSHOT', 'this checkpoint does not cover the current board and prefix; fetch a consistent relay snapshot or join by pairing');
  }
  const engine = Number(meta.get('relay_engine_version'));
  if (!Number.isSafeInteger(engine) || engine < 1) throw new Refused('RELAY_SNAPSHOT', 'this checkpoint has no supported engine version; upgrade pullboard or join by pairing');
  if (engine > ENGINE_VERSION) throw new Refused('ENGINE_VERSION', `snapshot engine version ${engine} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard before applying the relay order`);
  const result = restoreDocument(board, document, true, expectedNativeDigest);
  importSeatObservations(board, document?.presentation?.state?.agents);
  return result;
}

/** Restore validated native rows with lifecycle guards suspended only inside the transaction. */
function restoreDocument(board, document, replace = false, expectedNativeDigest = null) {
  const db = board.db;
  // The hop table is opt-in: a document that carries its rows gives this board the table first, so the two table sets agree [C7].
  if (document?.tables && typeof document.tables === 'object' && Object.hasOwn(document.tables, 'gate_hop')) ensureGateHopTable(db);
  const names = tableNames(db);
  validateDocument(db, document, names);
  prepareBoardWriteIdentity();
  const marker = prepareBoardWriteMarker(db, board.writeContext);
  try { db.exec('PRAGMA defer_foreign_keys = ON'); beginImmediateQueued(db, Date.now(), marker); }
  catch (error) { discardBoardWriteMarker(marker); throw error; }
  const writeRecord = beginBoardWrite(db, board.writeContext, marker);
  // A snapshot restore is its own move body, so its hold row names it instead of leaving move null (#3336).
  writeRecord.move = 'restoreDocument';
  let released = false;
  let outcome = 'release-failed';
  try {
    const localLanding = db.prepare('SELECT * FROM board_meta WHERE meta_key GLOB ?').all(LANDING_LOCAL_PREFIX + '*');
    let localAgentCursors = null;
    if (expectedNativeDigest !== null) {
      const current = { version: VERSION, tables: exportedTables(db, names) };
      current.tables.board_meta = board.nativePorts.exportedMeta(current.tables.board_meta);
      const actual = semanticBoardDigest(current);
      if (actual !== expectedNativeDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed before checkpoint restore; its changes were preserved, export them and retry recovery');
      localAgentCursors = new Map(current.tables.agent.map((row) => [row.agent_id, row.agent_last_shout_id]));
    }
    const onlyIdentity = hasOnlyIdentity(db);
    const occupied = names.filter((table) => !(table === 'board_meta' && onlyIdentity) && db.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get());
    const initCoordinator = occupied.length > 0 && hasOnlyInitCoordinator(db, names);
    if (occupied.length && !initCoordinator && !replace) {
      throw new Refused('IMPORT_NOT_EMPTY', `board tables already have rows (${occupied.join(', ')}); import into a repo with an empty board`);
    }
    // Signed person moves survive a restore: this board keeps its own relay key pin and its signing state [E22].
    const restoreGuards = suspendStoreGuards(board);
    const signing = board.nativePorts.guardRestore(db, document);
    if (replace) {
      for (const table of [...names].reverse()) db.exec(`DELETE FROM ${identifier(table)}`);
    } else if (initCoordinator) {
      db.exec('DELETE FROM event; DELETE FROM agent; DELETE FROM sqlite_sequence');
    }
    if ((onlyIdentity || initCoordinator) && !replace) db.exec('DELETE FROM board_meta');
    for (const table of names.filter((name) => name !== 'sqlite_sequence')) {
      const columns = columnsOf(db, table);
      const sql = `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      const insert = db.prepare(sql);
      for (const row of suppliedRows(document, table)) {
        if (table === 'board_meta' && (row.meta_key.startsWith(PROOF_COUNTER_PREFIX) || row.meta_key.startsWith(LANDING_LOCAL_PREFIX) || row.meta_key.startsWith(FAMILY_RECORD_PREFIX))) continue;
        let restored = row;
        if (replace && expectedNativeDigest !== null && table === 'agent' && localAgentCursors.has(row.agent_id)) {
          const localCursor = localAgentCursors.get(row.agent_id);
          const cursors = [localCursor, row.agent_last_shout_id].filter(validReadCursor);
          if (cursors.length) restored = { ...row, agent_last_shout_id: Math.max(...cursors) };
        }
        insert.run(...columns.map((column) => restored[column]));
      }
    }
    db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('event_log_version', String(EVENT_LOG_VERSION));
    signing();
    const setSequence = db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?');
    for (const row of document.tables.sqlite_sequence ?? []) {
      if (!setSequence.run(row.seq, row.name).changes) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(row.name, row.seq);
    }
    const restoreLocal = db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)');
    for (const row of localLanding) restoreLocal.run(row.meta_key, row.meta_value);
    rebuildProofCounters(board, { refresh: false });
    warmFamilyProjection(board);
    restoreGuards();
    db.exec('COMMIT');
    released = true;
    outcome = 'committed';
    // Report the tables the document carried, so an additive table the export left out is not listed as imported [C7].
    return { tables: names.filter((table) => !ADDITIVE_TABLES.has(table) || Object.hasOwn(document.tables, table)) };
  } catch (error) {
    db.exec('ROLLBACK');
    released = true;
    outcome = 'rolled-back';
    throw error;
  } finally {
    finishBoardWrite(writeRecord, released, outcome);
  }
}
