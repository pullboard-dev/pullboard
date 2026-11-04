/**
 * Socket-path and connection endings for the resident board process [H24]. They live apart from bin/resident-board.js,
 * which starts a server when imported, so a test can prove them on real sockets.
 */
import {
  linkSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';

/** A path's file identity now, or null when nothing is there. */
export function pathIdentity(path) {
  try { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/**
 * Remove the socket path only when it is still this process's socket. Why rename first: a stat and then an unlink
 * can delete a successor that binds between them. A rename is atomic, so the file moved aside is exactly the one
 * checked; a successor's socket is linked back without replacing anything newer, so its holder keeps its path.
 *
 * @param {string} path The socket path.
 * @param {string|null} own The identity of the socket this process bound.
 * @param {string} tag A name unique to this process, for the moved-aside file.
 * @returns {boolean} True when this process's own socket was removed.
 */
export function releaseOwnSocket(path, own, tag) {
  if (process.platform === 'win32' || !own) return false;
  const aside = `${path}.${tag}.retired`;
  try { renameSync(path, aside); } catch { return false; }
  const mine = pathIdentity(aside) === own;
  // A newer socket already at the path wins; then the moved one's holder is superseded and retires on its next check.
  if (!mine) try { linkSync(aside, path); } catch { /* A newer process holds the path. */ }
  try { unlinkSync(aside); } catch { /* Already gone. */ }
  return mine;
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
