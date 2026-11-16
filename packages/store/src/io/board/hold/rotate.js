/** Rotation of the machine every-write log, run between commands and never inside a board write [C7,#6478]. */
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { boardWritesLog } from './log.js';

/** The size past which the every-write log moves to its one prior file, so the log cannot grow without bound. */
export const BOARD_WRITES_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Move the every-write log to `<log>.1` once it passes the cap, replacing any older prior file.
 * Why: a rename inside a board write is external I/O the write path forbids, so a command runs this after it finishes;
 * a writer that still holds the old file open appends to the prior file, and the next open starts a fresh log, so no write is lost.
 *
 * @returns {boolean} Whether a rotation happened.
 */
export function rotateBoardWritesLog() {
  const file = boardWritesLog();
  try {
    if (statSync(file).size <= BOARD_WRITES_MAX_BYTES) return false;
    renameSync(file, file + '.1');
    return true;
  } catch { return false; /* A missing log has nothing to rotate; a failed rename leaves the log growing, which loses nothing. */ }
}
