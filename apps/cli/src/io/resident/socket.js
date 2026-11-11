/**
 * Socket-path ownership for the resident board process [H24]. Every start, from its bind or takeover until its pid
 * file names it, and every retirement's removal of its socket and pid file, runs under one exclusive path lock, so no
 * check and the unlink that follows it can interleave with another process's. The lock is an exclusive SQLite
 * transaction on a file beside the socket. Why SQLite: its lock is the kernel's, so a process that dies releases it
 * with nothing to detect or break. These live apart from apps/cli/src/io/resident/board.js, which starts a server when imported,
 * so a test can prove them on real sockets.
 */
import {
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** A path's file identity now, or null when nothing is there. */
export function pathIdentity(path) {
  try { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/** Whether a process id names a live process other than this one. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** How long a starter waits on the path lock: a holder keeps it only from the bind until its pid file names it. */
export const LOCK_WAIT_MS = 250;

/**
 * Take the socket path's lock, waiting at most LOCK_WAIT_MS, or return null when another process still holds it.
 * Why the wait: two starters opening a fresh lock file at once could each find the other busy with no wait, so both
 * left and no resident served the path (#3168); a holder keeps the lock for only a few milliseconds.
 *
 * @param {string} path The socket path the lock guards.
 * @returns {(() => void)|null} The release function; calling it again does nothing.
 */
export function lockPath(path) {
  let db = null;
  try {
    db = new DatabaseSync(`${path}.lock`, { timeout: LOCK_WAIT_MS });
    db.exec('BEGIN EXCLUSIVE');
  } catch {
    try { db?.close(); } catch { /* Never opened. */ }
    return null;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try { db.exec('COMMIT'); } catch { /* Closing ends the transaction too. */ }
    try { db.close(); } catch { /* Already closed. */ }
  };
}

/**
 * Remove the socket path and pid file only while they are still this process's, under the path lock. When the lock
 * is busy both are left as they are: a starter holding it finds this process live, and once it exits the path is stale
 * and taken over then.
 *
 * @param {string} path The socket path.
 * @param {string|null} own The identity of the socket this process bound.
 * @param {string} pidFile The file that names the path's live holder.
 * @returns {boolean} True when this process's own socket was removed.
 */
export function releaseOwnSocket(path, own, pidFile) {
  const unlock = lockPath(path);
  if (!unlock) return false;
  try {
    const mine = own !== null && pathIdentity(path) === own;
    if (mine) try { unlinkSync(path); } catch { /* Already gone. */ }
    try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* Already gone. */ }
    return mine;
  } finally { unlock(); }
}

/**
 * Whether a retired process may exit with these responses still unwritten: each has had its own flush window, counted
 * from when it was queued or the process retired, whichever is later. Why per response: a command that finishes long
 * after retirement still gets the whole window for its client to read its output.
 *
 * @param {Iterable<{at: number}>} pending When each unwritten response was queued.
 * @param {number} retiredAt
 * @param {number} now
 * @param {number} windowMs
 */
export function flushesDue(pending, retiredAt, now, windowMs) {
  return [...pending].every(entry => now - Math.max(entry.at, retiredAt) >= windowMs);
}

/**
 * End a client connection with its last line and call onFlushed once that line is written or the client has gone,
 * so a retiring process never exits with a response still queued. onFlushed runs exactly once.
 *
 * @param {import('node:net').Socket} socket
 * @param {string} line
 * @param {() => void} onFlushed
 */
export function endThen(socket, line, onFlushed) {
  let settled = false;
  const settle = () => { if (!settled) { settled = true; onFlushed(); } };
  if (socket.destroyed) return void setImmediate(settle);
  socket.once('finish', settle);
  socket.once('close', settle);
  socket.end(line);
}
