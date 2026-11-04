/**
 * Event sources a runner controller waits on instead of a once-a-second timer, so a controller holding a long
 * remote job sleeps until something it watches actually changes (#2519) [C7].
 */
import { watch } from 'node:fs';
import { Socket } from 'node:net';
import { basename } from 'node:path';
import { dirname } from 'node:path';

/** The extra pipe a dispatching process hands its controller; its end of the pipe closes when that process dies. */
export const PARENT_PIPE_FD = 3;

/**
 * Call `onGone` once when the dispatching process's end of the parent pipe closes, which the kernel does when that
 * process exits however it ends. Returns a closer, or null when no such pipe was handed over.
 * @param {number|undefined} fd
 * @param {() => void} onGone
 * @returns {(() => void)|null}
 */
export function watchParentPipe(fd, onGone) {
  if (fd !== PARENT_PIPE_FD) return null;
  let pipe;
  try { pipe = new Socket({ fd, readable: true, writable: false }); }
  catch { return null; }
  let closed = false;
  const gone = () => { if (!closed) { closed = true; onGone(); } };
  pipe.on('end', gone);
  pipe.on('close', gone);
  pipe.on('error', gone);
  // Nothing is ever written; reading only lets the end of the pipe arrive. The pipe never holds the process open.
  pipe.resume();
  pipe.unref();
  return () => { closed = true; pipe.destroy(); };
}

/**
 * Watch the folders that hold some paths and call `onChange` after a change to one of them settles. A burst of
 * writes, as a busy board makes, runs `onChange` once per `settleMs` at most, so the cost follows real changes
 * rather than the clock. Throws when the platform cannot watch one of the folders, so the caller can keep its
 * previous observation instead.
 * @param {string[]} paths files or folders whose replacement, removal or change matters, with SQLite's -wal and -journal
 * @param {() => void} onChange
 * @param {{ settleMs?: number }} [options]
 * @returns {() => void} a closer
 */
export function watchPaths(paths, onChange, { settleMs = 1_000 } = {}) {
  const byFolder = new Map();
  for (const path of paths) {
    const folder = dirname(path);
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder).add(basename(path));
  }
  let timer = null, last = 0;
  const run = () => { timer = null; last = Date.now(); onChange(); };
  const changed = () => {
    if (timer) return;
    timer = setTimeout(run, Math.max(0, last + settleMs - Date.now()));
  };
  const watchers = [];
  try {
    for (const [folder, names] of byFolder) {
      const watcher = watch(folder, { persistent: false }, (event, name) => {
        // A platform that cannot name the entry still reports a change to the folder. A write reaches the database,
        // its -wal or its -journal; -shm is left out because a reader's own open touches it, which would wake us again.
        if (!name || [...names].some(base => [base, `${base}-wal`, `${base}-journal`].includes(String(name)))) changed();
      });
      watcher.on('error', changed);
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}

/**
 * Wake a controller's observation on events: the dispatching process's pipe closing, a source folder being
 * replaced or removed, and a write to a file the item's observation reads (each git config on the way to its board,
 * and the board). Only a caller without one of those sources (an older dispatcher with no parent pipe, an item whose
 * board cannot be found, a platform that cannot watch) keeps the once-a-second observation it had before.
 * @param {{ parentPipe?: number }} request
 * @param {{ roots: string[], itemFiles: string[], needsBoard: boolean, abort: () => void, observe: () => void }} sources
 * @returns {() => void} a closer
 */
export function controllerWake(request, { roots, itemFiles, needsBoard, abort, observe }) {
  const parent = watchParentPipe(request.parentPipe, abort);
  let paths = null;
  if (!needsBoard || itemFiles.some(file => file.endsWith('board.sqlite'))) {
    try { paths = watchPaths([...roots, ...itemFiles], observe); }
    catch { paths = null; }
  }
  if (parent && paths) return () => { parent(); paths(); };
  // Budget: without every event source, observe the originating process and exact source directories once per second.
  const timer = setInterval(observe, 1000);
  return () => { parent?.(); paths?.(); clearInterval(timer); };
}
