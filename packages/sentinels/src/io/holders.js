/**
 * The slow board write's holder, kept durably [C7]. When sentinels.recordWriteHolder is on, the wait audit keeps the
 * newest holders of over-budget board writes in the board's own key-value table (board_meta, key `write_holders`): the
 * holder's command line, pid and held time, and each waiter's pid and wait.
 *
 * Why: #8496 fixed a 9.1 s board-write hold nobody could explain, because the evidence of who held it was a file that
 * was gone before anyone read it (#8996). The record is a small mutable observation, never the immutable activity history.
 */
import { readBoardMeta } from '../../../store/index.js';
import { writeBoardMeta } from '../../../store/index.js';
import { recordWriteHolderEnabled } from '../../../config/index.js';

/** The board_meta key holding the records. */
export const WRITE_HOLDERS_KEY = 'write_holders';

/** The newest records kept, so the observation stays small. */
const KEEP = 50;

/** The recorded holders, oldest first; none when nothing was recorded. */
export function readWriteHolders(db) {
  const text = readBoardMeta(db, WRITE_HOLDERS_KEY);
  return text ? JSON.parse(text) : [];
}

/**
 * Keep the holder of one over-budget board-write row, unless the same holder (pid and acquiring command) is already
 * the newest record. Returns whether a record was added.
 *
 * @param {object} db - The board's database.
 * @param {object} row - A judged `board-write` row from the wait snapshot.
 * @param {number} at - Milliseconds since the epoch.
 */
export function appendWriteHolder(db, row, at) {
  const kept = readWriteHolders(db);
  const last = kept.at(-1);
  if (last?.holderPid === row.pid && last?.holder === row.holder) return false;
  const record = { at: new Date(at).toISOString(), holder: row.holder, holderPid: row.pid ?? null, command: row.context ?? null,
    heldMs: row.ageMs, budgetMs: row.budgetMs,
    waiters: (row.waiters ?? []).map(waiter => ({ pid: waiter.pid ?? null, label: waiter.label, waitMs: waiter.ageMs, command: waiter.context ?? null })) };
  writeBoardMeta(db, WRITE_HOLDERS_KEY, JSON.stringify([...kept, record].slice(-KEEP)));
  return true;
}

/**
 * The recorder the wait audit calls for each over-budget board write, or null while sentinels.recordWriteHolder is off
 * (the default), so nothing is recorded.
 */
export function writeHolderRecorder(db, now = () => Date.now()) {
  return recordWriteHolderEnabled() ? row => appendWriteHolder(db, row, now()) : null;
}
