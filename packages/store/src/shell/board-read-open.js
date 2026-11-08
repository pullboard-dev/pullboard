import { closeBoardWrites } from "./board-write-lock.js";
/** Open existing board data without loading move execution [C7]. */
import {
  existsSync,
  readdirSync,
} from 'node:fs';
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

let heldReadConnection = null;

/**
 * Let a long-lived process supply the read-only connection every read open uses, or null to open one as usual.
 * Why: the resident board process keeps the board open across commands; a fresh process never installs one.
 *
 * @param {((file: string) => DatabaseSync | null) | null} provider
 */
export function holdReadConnections(provider) {
  heldReadConnection = provider;
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
  // A long-lived process, the resident board process, hands out read-only connections it already holds.
  const db = connection ?? heldReadConnection?.(file) ?? openBoardReadOnly(file);
  try { readEventLogVersion(db); return { ...readBoardSnapshot(db, clock), readOnly: true, current: boardIsCurrent(db, SCHEMA_DIGEST, SCHEMA_VERSION) }; }
  catch (error) { db.close(); throw error; }
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
  try { return readdirSync('/dev/fd').length; } catch { return null; }
}

/** Open an existing board without migrations, waiting for the same locks as openBoard. */
export function openBoardReadOnly(file, { sleep = pauseMs, now = Date.now, budgetMs = CANTOPEN_RETRY_MS, openFiles = openFileCount } = {}) {
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
      if (!isCantOpen(error)) throw boardBusyError(file, startedAt, error);
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

