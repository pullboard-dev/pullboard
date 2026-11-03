import { closeBoardWrites } from "./board-write-lock.js";
/** Open existing board data without loading move execution [C7]. */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { boardBusyError } from "./board-access.js";
import { boardIsCurrent } from "./board-migrate.js";
import {
  BOARD_BUSY_TIMEOUT_MS,
  EVENT_LOG_VERSION,
  SIGNED_EVENT_LOG_VERSION,
  SCHEMA_DIGEST,
  SCHEMA_VERSION,
} from "./board-schema-source.js";
import { Refused } from "../../../kernel/index.js";
// Preserve eager validation of feature declarations without loading lifecycle guards.
import { ENGINE_REGISTRY } from "../../../../src/engine-metadata.js";
import { ENGINE_VERSION } from "../../../../src/engine-metadata.js";

/** Supply exact discovered engine thresholds to read-only projections. */
function submitHandoffEngines() { return { current: ENGINE_VERSION, handoff: ENGINE_REGISTRY['submit-handoff'] }; }

/** Attach the native read-only engine thresholds to an existing observation snapshot. */
export function readBoardSnapshot(db, clock = systemClock) {
  return { db, clock, enginePorts: Object.freeze({ submitHandoffEngines }) };
}

/**
 * The clock the board reads, real unless a test passes its own.
 */
export const systemClock = { now: () => new Date() };

/**
 * Open an existing board for a command that only reads: read-only, with no write lock and no
 * migration, so a writer holding the lock never stalls it (#1047). `current` says whether this
 * code's migration has run on it; only a write open migrates. Null when there is no board yet.
 */
export function openBoardForRead(file, clock = systemClock, { connection = null } = {}) {
  if (file === ':memory:' || !existsSync(file)) return null;
  // A long-lived caller, the resident board process, may hand back a read-only connection it already holds.
  const db = connection ?? openBoardReadOnly(file);
  try { readEventLogVersion(db); return { ...readBoardSnapshot(db, clock), readOnly: true, current: boardIsCurrent(db, SCHEMA_DIGEST, SCHEMA_VERSION) }; }
  catch (error) { db.close(); throw error; }
}

/** Open an existing board without migrations, waiting for the same locks as openBoard. */
export function openBoardReadOnly(file) {
  const startedAt = Date.now();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the opening error if cleanup also fails. */ }
    throw boardBusyError(file, startedAt, error);
  }
}

/**
 * Read the persisted event format without migrating it, so integrity checks enforce the same
 * compatibility rule as the writable opener while leaving older or damaged evidence intact.
 *
 * @param {DatabaseSync} db
 * @returns {number}
 */
export function readEventLogVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_meta'").get()) return 0;
  const stored = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version');
  const version = stored && /^(?:0|[1-9]\d*)$/u.test(stored.meta_value) ? Number(stored.meta_value) : stored ? NaN : 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${stored?.meta_value ?? 'missing'} is invalid; restore a valid board or upgrade pullboard`);
  }
  if (version > Math.max(EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION)) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${version} is newer than this pullboard version ${SIGNED_EVENT_LOG_VERSION}; upgrade pullboard to open this board`);
  }
  return version;
}

/**
 * Close the board's file.
 *
 * @param {{ db: DatabaseSync }} board
 */
export function closeBoard(board) {
  board.db.close();
  closeBoardWrites(board.db);
}

