import { closeBoardWrites } from "../write/lock.js";
/** Open existing board data without loading move execution [C7]. */
import {
  existsSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CANTOPEN_RETRY_MS } from "./light.js";
import { readBoardSnapshot } from "./light.js";
import { systemClock } from "./light.js";
import { openBoardReadOnly as openReadOnlyLight } from "./light.js";
import { boardBusyError } from "../access.js";
import { boardIsCurrent } from "../migrate.js";
import {
  EVENT_LOG_VERSION,
  SIGNED_EVENT_LOG_VERSION,
  SCHEMA_DIGEST,
  SCHEMA_VERSION,
} from "../schema/source.js";
import { Refused } from "../../../../../kernel/index.js";
// Preserve eager validation of feature declarations without loading lifecycle guards.
import { ENGINE_REGISTRY } from "../../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";


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

/** Open an existing board without migrations, naming the process that holds its write lock when the wait runs out. */
export function openBoardReadOnly(file, options = {}) {
  return openReadOnlyLight(file, { busyError: (path, startedAt, error) => boardBusyError(path, startedAt, error), ...options });
}
export { CANTOPEN_RETRY_MS };
export { readBoardSnapshot };
export { systemClock };

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

