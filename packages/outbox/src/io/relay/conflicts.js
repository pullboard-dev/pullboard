/**
 * Conflict notices (#1013): a queued move another machine beat is refused when the relay's order replays, in the
 * background sender, which has no terminal. The refusal is left beside the link for the worktree whose agent made
 * the move, and that worktree's next command says it, loudly, once.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';

/** The folder of notices beside a link file. */
function noticeDirectory(linkFile) {
  return join(dirname(linkFile), 'relay-conflicts');
}

/** The notice file for one worktree, named by a digest of its path so no path text lands in a file name. */
function noticeFile(linkFile, worktree) {
  return join(noticeDirectory(linkFile), createHash('sha256').update(worktree).digest('hex').slice(0, 32) + '.txt');
}

/**
 * Leave a refusal line for the agent working in `worktree`.
 *
 * @param {string} linkFile - The board's relay link file.
 * @param {string} worktree - The agent's worktree path, as the board registers it.
 * @param {string} line - The refusal, naming the move that won.
 */
export function leaveConflictNotice(linkFile, worktree, line) {
  mkdirSync(noticeDirectory(linkFile), { recursive: true, mode: 0o700 });
  appendFileSync(noticeFile(linkFile, worktree), JSON.stringify(line) + '\n', { mode: 0o600 });
}

/**
 * Take the refusals left for `worktree`, oldest first, removing them so each is said once. A notice is moved aside
 * before it is read, so a sender adding one meanwhile starts a fresh file instead of losing its line.
 *
 * @param {string} linkFile
 * @param {string} worktree
 * @returns {string[]}
 */
export function takeConflictNotices(linkFile, worktree) {
  const file = noticeFile(linkFile, worktree);
  const taken = `${file}.${process.pid}.taken`;
  try { renameSync(file, taken); } catch { return []; }
  try {
    return readFileSync(taken, 'utf8').split('\n').filter(Boolean).flatMap((row) => {
      try { return [String(JSON.parse(row))]; } catch { return []; }
    });
  } finally { rmSync(taken, { force: true }); }
}
