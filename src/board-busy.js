import { boardWriteHolderText } from './board-write-lock.js';
/** Translate SQLite lock contention without coupling error reporting to the full board store [C7]. */
import { Refused } from './refused.js';
import { writeSync } from 'node:fs';
import { BOARD_BUSY_TIMEOUT_MS } from './board-schema-source.js';

/** Recognize SQLite's busy code, including extended busy result codes. */
function isBusy(error) {
  const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : null;
  return sqliteCode === 5 || error.code === 'SQLITE_BUSY' || /database is locked/iu.test(error.message ?? '');
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


/** Extra time, beyond SQLite's own busy timeout, a board write queues for the lock before BOARD_BUSY (#1854). */
const DEFAULT_QUEUE_MS = 50_000;

/** Read the bound per call so a caller or test can set PULLBOARD_BOARD_QUEUE_MS=0 to refuse at SQLite's timeout. */
function queueMs() {
  const raw = process.env.PULLBOARD_BOARD_QUEUE_MS;
  const value = raw === undefined || raw === '' ? DEFAULT_QUEUE_MS : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUEUE_MS;
}

/**
 * Take the outermost write lock, queueing behind another writer instead of failing at the first busy timeout.
 * SQLite's busy handler is unfair, so one 10 s attempt can lose to a rival's back-to-back short writes
 * although each hold is tens of milliseconds. Each retry is another full attempt; every expired attempt
 * prints the wait and the observed holder, and only a wait past the queue bound refuses with BOARD_BUSY.
 *
 * @param {any} db
 * @param {number} startedAt
 */
export function beginImmediateQueued(db, startedAt) {
  const bound = queueMs();
  for (;;) {
    try { db.exec('BEGIN IMMEDIATE'); return; }
    catch (error) {
      const refusal = boardWriteBusyError(db, startedAt, error);
      if (refusal === error || bound === 0 || db.prepare('PRAGMA busy_timeout').get().timeout === 0 || Date.now() - startedAt >= BOARD_BUSY_TIMEOUT_MS + bound) throw refusal;
      try { writeSync(2, `pullboard: board write queued, still waiting for the lock (up to ${Math.round((BOARD_BUSY_TIMEOUT_MS + bound) / 1000)}s): ${refusal.message}\n`); }
      catch { /* A closed diagnostic stream must not turn a queued write into a refusal. */ }
    }
  }
}
