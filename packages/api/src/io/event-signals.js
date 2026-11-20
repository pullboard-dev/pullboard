/** A live-stream watcher that wakes only when the board's newest event id moves [A2,C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { join } from 'node:path';
import { repoInfo } from '../../../git/index.js';
import * as store from '../../../store/index.js';

const fs = fileSystemAdapter();

/** How long a burst of board writes is gathered before the newest event id is read once. */
const EVENT_SETTLE_MS = 50;

/**
 * A watcher for a client that wants events only. A busy board writes constantly with no new event
 * (presence, resources, cost), so each burst of writes costs one timer and one indexed read of the
 * newest event id on a retained connection: no state revision, no board open, no per-write stats.
 * It wakes the stream only when that id moved. Writes are noticed by native file watches on the
 * board and its log (and the folder, for a replaced file), never by polling.
 */
export function watchEventSignals(board) {
  const info = repoInfo(board.root);
  const folder = join(info.commonDir, 'pullboard');
  const dbPath = join(folder, 'board.sqlite');
  const inputs = new Set(['board.sqlite', 'board.sqlite-wal']);
  const listeners = new Set();
  const watches = new Map();
  let folderWatch = null;
  let db = null;
  let inode = null;
  let timer = null;
  let closed = false;
  let last = 0;
  let replaced = false;
  /** Tell every listener of this stream, or of its failure. */
  const notify = (error) => { for (const listener of [...listeners]) listener(error); };
  /** Watch each existing input itself: a file watch sees SQLite's in-place log writes where a folder watch does not. */
  const bind = () => {
    for (const path of [dbPath, dbPath + '-wal']) {
      let ino = null;
      try { ino = fs.stat(path).ino; } catch { /* A missing input is picked up by the folder watch when it appears. */ }
      const known = watches.get(path);
      if (known && known.ino !== ino) { known.watcher.close(); watches.delete(path); }
      if (ino === null || watches.has(path)) continue;
      const watcher = fs.watch(path, (event) => { if (event === 'rename') replaced = true; wake(); });
      watcher.on('error', notify);
      watches.set(path, { ino, watcher });
    }
  };
  /** The newest event id, reopening the connection only when a rename or new file says the board file may have been replaced. */
  const newest = () => {
    if (!db || replaced) {
      replaced = false;
      const current = fs.stat(dbPath).ino;
      if (!db || current !== inode) { const next = store.openBoardReadOnly(dbPath); db?.close(); db = next; inode = current; }
    }
    return db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
  };
  /** Read once for the whole burst of writes that arrived since the timer started. */
  const settle = () => {
    timer = null;
    if (closed) return;
    let id;
    try { if (replaced) bind(); id = newest(); } catch (error) { notify(error); return; }
    if (id !== last) { last = id; notify(); }
  };
  function wake() { if (!closed && timer === null) timer = setTimeout(settle, EVENT_SETTLE_MS); }
  const release = () => {
    closed = true;
    clearTimeout(timer);
    folderWatch?.close();
    for (const { watcher } of watches.values()) watcher.close();
    db?.close();
  };
  try {
    folderWatch = fs.watch(folder, (event, name) => { if (name === null || inputs.has(String(name))) { if (event === 'rename' || name === null) replaced = true; wake(); } });
    folderWatch.on('error', notify);
    bind();
    // Taken before the stream replays its events, so a write between the two still wakes it.
    last = newest();
  } catch (error) { release(); throw error; }
  return {
    revision: () => '',
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { if (!closed) release(); },
  };
}
