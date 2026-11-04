/**
 * Socket-path ownership for the resident board process [H24]. Every change to an existing socket path, a stale path
 * taken over or a retiring owner's path removed, happens under one exclusive lock file beside it, so a check and the
 * unlink that follows it can never interleave with another process's. Binding a free path needs no lock: a bind never
 * replaces a file. These live apart from bin/resident-board.js, which starts a server when imported, so a test can
 * prove them on real sockets.
 */
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** A path's file identity now, or null when nothing is there. */
export function pathIdentity(path) {
  try { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/** Whether a process id names a live process other than this one. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** The process id a file names, or NaN. */
function pidIn(file) {
  try { return Number(readFileSync(file, 'utf8').trim()); } catch { return Number.NaN; }
}

/**
 * Take the path lock, or return null when a live process holds it. A lock whose holder died is moved aside and
 * checked once more, so a lock taken fresh by a live process in between is put back instead of broken.
 *
 * @param {string} path The socket path the lock guards.
 * @returns {(() => void)|null} The release function.
 */
export function lockPath(path) {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return () => { if (pidIn(lock) === process.pid) try { unlinkSync(lock); } catch { /* Already gone. */ } };
    } catch (error) { if (error?.code !== 'EEXIST') return null; }
    if (processAlive(pidIn(lock))) return null;
    const aside = `${lock}.${process.pid}.stale`;
    try { renameSync(lock, aside); } catch { continue; }
    // Why: another process may have broken the dead lock and taken a fresh one just before this rename.
    if (processAlive(pidIn(aside))) {
      try { linkSync(aside, lock); } catch { /* A newer lock is in place. */ }
      try { unlinkSync(aside); } catch { /* Already gone. */ }
      return null;
    }
    try { unlinkSync(aside); } catch { /* Already gone. */ }
  }
  return null;
}

/**
 * Remove the socket path only while it is still this process's socket, under the path lock. When the lock is busy the
 * path is left as it is: a stale socket is taken over later, and a live one is never removed.
 *
 * @param {string} path The socket path.
 * @param {string|null} own The identity of the socket this process bound.
 * @returns {boolean} True when this process's own socket was removed.
 */
export function releaseOwnSocket(path, own) {
  if (process.platform === 'win32' || !own) return false;
  const unlock = lockPath(path);
  if (!unlock) return false;
  try {
    if (pathIdentity(path) !== own) return false;
    unlinkSync(path);
    return true;
  } catch { return false; } finally { unlock(); }
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
