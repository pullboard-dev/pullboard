import { boardWriteHolderText } from "./write/lock.js";
import { discardBoardWriteMarker } from "./write/lock.js";
/** Translate SQLite lock contention without coupling error reporting to the full board store [C7]. */
import { Refused } from "../../../../kernel/index.js";
import { writeSync } from 'node:fs';
import { BOARD_BUSY_TIMEOUT_MS } from "./schema/source.js";

/** Recognize SQLite's busy code, including extended busy result codes. */
function isBusy(error) {
  const sqliteCode = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return sqliteCode === 5 || sqliteCode === 6 || error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' || /database is locked/iu.test(error?.message ?? '');
}

/**
 * Replace SQLite's bare lock error with the board path and elapsed wait when the wait expires.
 *
 * @param {string} file
 * @param {number} startedAt
 * @param {Error & { errcode?: number }} error
 * @returns {Error}
 */
export function boardBusyError(file, startedAt, error) {
  if (!isBusy(error)) return error;
  return new Refused('BOARD_BUSY', `board file ${file} remained held by another process after ${Date.now() - startedAt}ms; wait for it to finish and retry${boardWriteHolderText(file)}`);
}

/** Name a failed write admission; resolve its board path only after real contention occurs. */
export function boardWriteBusyError(db, startedAt, error) {
  if (!isBusy(error)) return error;
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || ':memory:';
  return boardBusyError(file, startedAt, error);
}


/** Translate a failed transaction without filesystem or process observations in the writer call graph. */
export function boardTransactionBusyError(db, startedAt, error) {
  if (!isBusy(error)) return error;
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || ':memory:';
  return new Refused('BOARD_BUSY', `board file ${file} remained held by another process after ${Date.now() - startedAt}ms; wait for it to finish and retry`);
}

/** Extra time, beyond SQLite's own busy timeout, a board write queues for the lock before BOARD_BUSY (#1854). */
const DEFAULT_QUEUE_MS = 0;

/** Read the bound per call so a caller or test can set PULLBOARD_BOARD_QUEUE_MS=0 to refuse at SQLite's timeout. */
function queueMs() {
  const raw = process.env.PULLBOARD_BOARD_QUEUE_MS;
  const value = raw === undefined || raw === '' ? DEFAULT_QUEUE_MS : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUEUE_MS;
}

/**
 * Take the outermost write lock, queueing behind another writer instead of failing at the first busy timeout.
 * Short busy-handler attempts retry within the normal ten-second deadline, so back-to-back writers
 * cannot consume a fresh ten seconds per attempt. An explicit legacy queue allowance extends that
 * deadline and announces the holder once; exhaustion always reports BOARD_BUSY.
 *
 * @param {any} db
 * @param {number} startedAt
 */
export function beginImmediateQueued(db, startedAt, marker = null) {
  const bound = BOARD_BUSY_TIMEOUT_MS + queueMs();
  const original = db.prepare('PRAGMA busy_timeout').get().timeout;
  const finish = globalThis[Symbol.for('pullboard.seat-timing.lock')]?.();
  let announced = false;
  try {
    for (;;) {
      const remaining = Math.max(1, bound - (Date.now() - startedAt));
      db.exec(`PRAGMA busy_timeout = ${Math.min(original, 100, remaining)}`);
      try { db.exec('BEGIN IMMEDIATE'); return; }
      catch (error) {
        if (!isBusy(error) || original === 0 || Date.now() - startedAt >= bound) {
          discardBoardWriteMarker(marker);
          throw boardWriteBusyError(db, startedAt, error);
        }
        if (!announced && Date.now() - startedAt >= BOARD_BUSY_TIMEOUT_MS) {
          announced = true;
          try { writeSync(2, `pullboard: board write queued, still waiting for the lock (up to ${Math.round(bound / 1000)}s)${boardWriteHolderText(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || ':memory:')}\n`); }
          catch { /* Diagnostics cannot turn a queued write into a refusal. */ }
        }
        // SQLITE_LOCKED has no busy handler; yield without spinning when it returns immediately.
        if ((error.errcode & 0xff) === 6 || error?.code === 'SQLITE_LOCKED') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
      }
    }
  } finally { db.exec(`PRAGMA busy_timeout = ${original}`); finish?.(); }
}
