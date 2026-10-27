import { boardWriteHolderText } from './board-write-lock.js';
/** Name a board this process cannot write, such as one inside a read-only agent sandbox [I1,P4]. */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { AGENT_SHELL_MARKERS } from './person.js';
import { Refused } from './refused.js';

/** The markers a Codex session sets; its sandbox needs the board folder named to Codex itself. */
const CODEX_MARKERS = AGENT_SHELL_MARKERS.filter((name) => name.startsWith('CODEX_'));

/**
 * Turn SQLite's bare readonly or cannot-open error, or a file-system access error, into a named
 * refusal that says which folder to open up; any other error comes back unchanged.
 * Why: an agent shown the raw readonly-database trace tends to read board.sqlite directly instead
 * (blueprint trial, #738), so the refusal names the folder and the access that gets past it.
 *
 * @param {string} file the board file
 * @param {Error & { errcode?: number, code?: string }} error
 * @returns {Error}
 */
export function boardNotWritable(file, error, environment = process.env) {
  const sqliteCode = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  if (sqliteCode !== 8 && sqliteCode !== 14 && !['EACCES', 'EPERM', 'EROFS'].includes(error?.code ?? '')) return error;
  const folder = dirname(file);
  // Codex's workspace-write sandbox keeps .git read-only; its own flag grants the one folder (#913).
  if (CODEX_MARKERS.some((name) => Boolean(environment[name]))) {
    // A named permission profile ignores the legacy writable_roots key, so each settings form gets its own step.
    return new Refused('BOARD_NOT_WRITABLE', `Cannot write the board in "${folder}": Codex's workspace-write sandbox keeps .git read-only.`,
      `restart Codex with that folder writable: codex --add-dir '${folder.replaceAll("'", "'\\''")}'; to keep it in ~/.codex/config.toml, a permission profile takes ${JSON.stringify(folder)} = "write" in its [permissions.<active-profile>.filesystem] table, and only settings without a profile use writable_roots under [sandbox_workspace_write]; then run the command again`);
  }
  return new Refused('BOARD_NOT_WRITABLE',
    `Cannot write the board in "${folder}". Give the agent write access to that folder, the repo's .git/pullboard, or run the command outside the sandbox.`);
}

/**
 * Check the write capability an agent needs after resume, without changing board data or taking its SQLite lock.
 * Opening the file for writing and creating one temporary sibling exercise actual sandbox permissions, including
 * journal creation; mode bits or access() alone cannot establish that capability. The sibling is removed immediately.
 */
export function requireBoardWriteAccess(file) {
  try {
    const board = openSync(file, 'r+');
    closeSync(board);
    const probe = join(dirname(file), `.write-access-${randomUUID()}`);
    const handle = openSync(probe, 'wx', 0o600);
    try { closeSync(handle); } finally { unlinkSync(probe); }
  } catch (error) {
    throw boardNotWritable(file, error);
  }
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
  const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : null;
  if (sqliteCode !== 5 && error.code !== 'SQLITE_BUSY' && !/database is locked/iu.test(error.message ?? '')) return error;
  return new Refused('BOARD_BUSY', `board file ${file} remained held by another process after ${Date.now() - startedAt}ms; wait for it to finish and retry${boardWriteHolderText(file)}`);
}
