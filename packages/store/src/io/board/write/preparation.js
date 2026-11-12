/** Optimistic preparation is bound to one connection's actual SQLite contents [B2,C7]. */
import { closeSync } from 'node:fs';
import { constants } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { Refused } from "../../../../../kernel/index.js";
import { boardWritesLog } from '../hold/log.js';

/** The tail of the machine's write log read to name a writer; a refusal never reads more. */
const WRITE_LOG_TAIL_BYTES = 64 * 1024;

/**
 * Capture other connections' commits and this connection's own intervening writes without a lock.
 * The latest event id and the wall-clock instant only name the writers a stale refusal reports.
 * @param {any} board
 * @returns {{version:number, changes:number, eventId:number|null, at:number}}
 */
export function boardWriteSnapshot(board) {
  let eventId = null;
  try { eventId = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id; }
  catch { /* A board without an event table still compares its data version. */ }
  return { version: board.db.prepare('PRAGMA data_version').get().data_version,
    changes: board.db.prepare('SELECT total_changes() AS n').get().n, eventId, at: Date.now() };
}

/**
 * Whether any write landed on the board since the snapshot.
 * @param {any} board
 * @param {{version:number, changes:number}} snapshot
 * @returns {boolean}
 */
export function boardWriteSnapshotChanged(board, snapshot) {
  const current = boardWriteSnapshot(board);
  return current.version !== snapshot.version || current.changes !== snapshot.changes;
}

/**
 * A changed snapshot must be prepared again; neither source work nor stale state runs under BEGIN.
 * @param {any} board
 * @param {{version:number, changes:number}} snapshot
 * @param {string} operation
 */
export function requireBoardWriteSnapshot(board, snapshot, operation) {
  if (boardWriteSnapshotChanged(board, snapshot)) throw staleBoardRefusal(board, snapshot, operation);
}

/**
 * The BOARD_BUSY refusal for a preparation another write overtook, naming what wrote since the snapshot.
 * Why: on 12 Nov claims refused for 20 minutes and nobody could tell which command kept changing the board.
 * @param {any} board
 * @param {{eventId?:number|null, at?:number}} snapshot
 * @param {string} operation
 * @returns {Refused}
 */
export function staleBoardRefusal(board, snapshot, operation) {
  return new Refused('BOARD_BUSY', `the board changed while preparing ${operation}; retry from the current board snapshot${observedWriterText(board, snapshot)}`);
}

/**
 * Name the writers since a snapshot: the board's own events (kind, seat, item) and the machine write log's
 * completed writes (command, seat, pid). Advisory and bounded; a failed read names nothing rather than refusing.
 * @param {any} board
 * @param {{eventId?:number|null, at?:number}} snapshot
 * @returns {string}
 */
export function observedWriterText(board, snapshot) {
  const parts = [];
  if (Number.isSafeInteger(snapshot?.eventId)) {
    try {
      const events = board.db.prepare('SELECT event_kind AS kind, event_by AS by, item_id AS item FROM event WHERE event_id > ? ORDER BY event_id DESC LIMIT 3')
        .all(snapshot.eventId).map(row => ({ kind: row.kind, by: row.by, item: row.item ?? null }));
      if (events.length) parts.push('events since preparation: ' + JSON.stringify(events));
    } catch { /* Naming the writer is advisory; the refusal stands without it. */ }
  }
  const writes = Number.isFinite(snapshot?.at) ? loggedWritesSince(snapshot.at) : [];
  if (writes.length) parts.push('observed writer records: ' + JSON.stringify(writes));
  return parts.length ? '; ' + parts.join('; ') : '';
}

/** Read the last committed writes at or after an instant from the machine's write log, newest first, at most three. */
function loggedWritesSince(at) {
  let fd;
  try {
    fd = openSync(boardWritesLog(), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const start = Math.max(0, stat.size - WRITE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    const rows = [];
    for (const line of lines.reverse()) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.outcome !== 'committed' || !(Date.parse(row.at) + (row.durationMs ?? 0) >= at)) continue;
      rows.push({ command: row.command, seat: row.seat, pid: row.pid ?? null, item: row.item ?? null, at: row.at });
      if (rows.length >= 3) break;
    }
    return rows;
  } catch { return []; /* No log is the normal case for a fresh machine. */ }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* Advisory read cleanup. */ }
  }
}
