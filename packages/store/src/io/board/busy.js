import { boardWriteHolderText } from "./write/lock.js";
import { discardBoardWriteMarker } from "./write/lock.js";
import { prepareBoardWriteIdentity } from "./write/lock.js";
import { prepareBoardWriteMarker } from "./write/lock.js";
import { beginBoardWrite } from "./write/lock.js";
import { finishBoardWrite } from "./write/lock.js";
/** Translate SQLite lock contention without coupling error reporting to the full board store [C7]. */
import { Refused } from "../../../../kernel/index.js";
import { BOARD_BUSY_TIMEOUT_MS } from "./schema/source.js";
import { fileSystemAdapter } from '../../../../fs/index.js';
const fileSystem = fileSystemAdapter();

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
  return new Refused('BOARD_BUSY', `board file ${file} remained held by another process after ${Date.now() - startedAt}ms; wait for it to finish and retry${boardWriteHolderText(file) || '; holder unrecorded: no live writer record names the process holding the lock'}`);
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
          try { fileSystem.write(2, `pullboard: board write queued, still waiting for the lock (up to ${Math.round(bound / 1000)}s)${boardWriteHolderText(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || ':memory:')}\n`); }
          catch { /* Diagnostics cannot turn a queued write into a refusal. */ }
        }
        // SQLITE_LOCKED has no busy handler; yield without spinning when it returns immediately.
        if ((error.errcode & 0xff) === 6 || error?.code === 'SQLITE_LOCKED') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
      }
    }
  } finally { db.exec(`PRAGMA busy_timeout = ${original}`); finish?.(); }
}

/**
 * Run `work` in one immediate transaction that records its hold like every board write: a marker beside the board while it
 * waits or holds, and a board-writes.jsonl row naming the command, pid and outcome once it commits or rolls back. Inside a
 * caller's open transaction it runs `work` in place, which that transaction's own record already covers. Why: a raw
 * BEGIN IMMEDIATE outside the store's atomic left a 347 s stall with no recorded holder (#11026) [C7].
 *
 * @template T
 * @param {{ db: any, writeContext?: object }} board
 * @param {() => T} work
 * @param {string} [move] - The move body's name for the hold row.
 * @returns {T}
 */
export function recordedWriteLock(board, work, move) {
  const db = board.db;
  prepareBoardWriteIdentity();
  const marker = prepareBoardWriteMarker(db, board.writeContext);
  try { beginImmediateQueued(db, Date.now(), marker); } catch (error) {
    discardBoardWriteMarker(marker);
    if (/within a transaction/u.test(String(error?.message))) return work();
    throw error;
  }
  const record = beginBoardWrite(db, board.writeContext, marker);
  if (move) record.move = move;
  let released = false;
  let outcome = 'release-failed';
  try {
    const result = work();
    db.exec('COMMIT');
    record.releasedAt = performance.now();
    released = true;
    outcome = 'committed';
    return result;
  } catch (error) {
    if (!released) {
      db.exec('ROLLBACK');
      record.releasedAt = performance.now();
      released = true;
      outcome = 'rolled-back';
    }
    throw error;
  } finally { finishBoardWrite(record, released, outcome); }
}
