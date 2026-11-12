/** A prepared spare checkout beside each seat, so a claim moves a ready folder instead of writing every tracked file [C7,#5776]. */
import { existsSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git } from '../../../../../../packages/git/index.js';
import { tryGit } from '../../../../../../packages/git/index.js';
import { gitPath } from '../../../../../../packages/git/index.js';

/**
 * Tracked files a repository needs before a spare is kept.
 * Why: a small repository's worktree add takes milliseconds, so a background checkout there only adds a folder and a process.
 */
export const SPARE_FROM_FILES = 1_000;

/** The spare checkout's path beside a seat checkout; its name never matches an item folder, so cleanup never removes it. */
export function spareFolderPath(seat) { return `${seat}-spare`; }

/** The number of entries in a checkout's index, read from the index header without launching Git; 0 when unreadable. */
function indexEntries(root) {
  let fd;
  try {
    fd = openSync(gitPath(root, 'index'), 'r');
    const header = Buffer.alloc(12);
    return readSync(fd, header, 0, 12, 0) === 12 && header.toString('latin1', 0, 4) === 'DIRC' ? header.readUInt32BE(8) : 0;
  } catch { return 0; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Whether the spare is this repository's registered, detached, unlocked worktree; a folder still being written is locked. */
function spareReady(root, spare) {
  let real;
  try { real = realpathSync(spare); } catch { return false; }
  for (const row of git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = row.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (path !== spare && path !== real) continue;
    return fields.includes('detached') && !fields.some(field => field === 'locked' || field.startsWith('locked '));
  }
  return false;
}

/**
 * Move this seat's prepared spare to the item folder and switch it to the item branch, rewriting only files that differ.
 * A spare that is missing, still being written, attached to a branch or dirty is left where it is, and the caller adds a worktree.
 * @param {string} root the repository root
 * @param {string} seat the seat checkout
 * @param {string} desired the item folder path
 * @param {string[]} checkout the Git arguments that put the moved folder on the item branch
 * @returns {boolean} true when the spare now is the item folder
 */
export function takeSpareFolder(root, seat, desired, checkout) {
  const spare = spareFolderPath(seat);
  if (!existsSync(spare) || !spareReady(root, spare)) return false;
  // Tracked files only: an untracked file would move along and show in the item's own status, so nothing is lost.
  const status = tryGit(spare, ['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0 || status.stdout) return false;
  if (tryGit(root, ['worktree', 'move', spare, desired]).status !== 0) return false;
  try { git(desired, checkout); }
  catch (error) { git(root, ['worktree', 'move', desired, spare]); throw error; }
  return true;
}

/**
 * Start writing a fresh spare in the background when the seat has none and the repository is large enough to need one.
 * The process is detached, so the command returns at once; Git locks the new worktree until its files are written.
 * A runner job never starts one: its processes die with the job (#2513).
 * @param {string} root the repository root
 * @param {string} seat the seat checkout
 * @param {string} trunk the trunk branch the spare starts from
 * @param {string[]} workers Git config arguments for parallel checkout
 * @returns {Promise<boolean>} true when a spare was started
 */
export async function prepareSpareFolder(root, seat, trunk, workers = []) {
  if (process.env.PULLBOARD_RUNNER_JOB) return false;
  const spare = spareFolderPath(seat);
  if (existsSync(spare) || indexEntries(root) < SPARE_FROM_FILES) return false;
  // Loaded only when a spare is due, so a claim's import graph stays as it was.
  const { startDetachedCheck } = await import('../../../../../../packages/drive/index.js');
  const started = startDetachedCheck(fileURLToPath(new URL('./scripts/spare.js', import.meta.url)), { args: [root, spare, trunk, ...workers], cwd: root });
  return started !== null;
}
