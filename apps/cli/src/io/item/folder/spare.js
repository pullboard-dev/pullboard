/** A prepared spare checkout beside each seat, so a claim moves a ready folder instead of writing every tracked file [C7,#5776]. */
import { fileSystemAdapter } from '../../../../../../packages/fs/index.js';
import { basename } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../../../../../../packages/git/index.js';
import { tryGit } from '../../../../../../packages/git/index.js';
import { gitPath } from '../../../../../../packages/git/index.js';
import { environmentAdapter } from '../../../../../../packages/env/index.js';

const fs = fileSystemAdapter();

/**
 * Tracked files a repository needs before a spare is kept.
 * Why: a small repository's worktree add takes milliseconds, so a background checkout there only adds a folder and a process.
 */
export const SPARE_FROM_FILES = 1_000;

/** The spare checkout's path beside a seat checkout; its name never matches an item folder, so cleanup never removes it. */
export function spareFolderPath(seat) { return `${seat}-spare`; }

/**
 * The number of entries in a checkout's index, read from the index header; 0 when unreadable.
 * The index path comes from the repository's files, and from Git only when those cannot answer (an inherited selector, a reftable store).
 * Why: asking Git for the path cost a process, 20-22 ms under load, on every claim of a new item folder (#10864).
 */
export function indexEntries(root) {
  let fd;
  try {
    fd = fs.open(gitPath(root, 'index', { files: true }), 'r');
    const header = Buffer.alloc(12);
    return fs.read(fd, header, 0, 12, 0) === 12 && header.toString('latin1', 0, 4) === 'DIRC' ? header.readUInt32BE(8) : 0;
  } catch { return 0; } finally { if (fd !== undefined) fs.close(fd); }
}

/** This repository's worktree registry fields for a folder, however its path was spelled, or null when it is not registered. */
function worktreeFields(root, folder) {
  let real;
  try { real = fs.realpath(folder); } catch { return null; }
  for (const row of git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = row.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (path === folder || path === real) return fields;
  }
  return null;
}

/** Whether the spare is this repository's registered, detached, unlocked worktree; a folder still being written is locked. */
function spareReady(root, spare) {
  const fields = worktreeFields(root, spare);
  return Boolean(fields) && fields.includes('detached') && !fields.some(field => field === 'locked' || field.startsWith('locked '));
}

/**
 * Free the item folder path before the spare moves there: an empty folder is removed, any other is kept beside it at
 * `<path>.prior-<time>`, moved with git worktree move when it is this repository's worktree so its checkout stays valid.
 * Why: git worktree move puts a worktree INSIDE an existing directory; a spare nested there with its own .git crashed
 * every later claim of the item at archive.js (#10784).
 * @param {string} root the repository root
 * @param {string} desired the item folder path, which exists
 * @returns {boolean} true when the path is free
 */
function setAsideItemFolder(root, desired) {
  let entries;
  try { entries = fs.list(desired); } catch { return false; }
  if (entries.length === 0) {
    try { fs.rmdir(desired); return true; } catch { return false; }
  }
  const kept = `${desired}.prior-${Date.now()}`;
  if (worktreeFields(root, desired)) {
    if (tryGit(root, ['worktree', 'move', desired, kept]).status !== 0) return false;
  } else {
    try { fs.rename(desired, kept); } catch { return false; }
  }
  process.stderr.write(`item folder ${desired} already existed; it is kept at ${kept}, and the seat's spare checkout takes its place\n`);
  return true;
}

/**
 * Move this seat's prepared spare to the item folder and switch it to the item branch, rewriting only files that differ.
 * A spare that is missing, still being written, attached to a branch or dirty is left where it is, and the caller adds a worktree.
 * A folder already at the item path is set aside first, so the spare never lands inside it (#10784).
 * @param {string} root the repository root
 * @param {string} seat the seat checkout
 * @param {string} desired the item folder path
 * @param {string[]} checkout the Git arguments that put the moved folder on the item branch
 * @returns {boolean} true when the spare now is the item folder
 */
export function takeSpareFolder(root, seat, desired, checkout) {
  const spare = spareFolderPath(seat);
  if (!fs.exists(spare) || !spareReady(root, spare)) return false;
  // Tracked files only: an untracked file would move along and show in the item's own status, so nothing is lost.
  const status = tryGit(spare, ['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0 || status.stdout) return false;
  if (fs.exists(desired) && !setAsideItemFolder(root, desired)) return false;
  if (tryGit(root, ['worktree', 'move', spare, desired]).status !== 0) return false;
  // A folder that appeared at the item path after the check still nests the spare: move it back out, and the caller's worktree add refuses plainly.
  const nested = join(desired, basename(spare));
  if (fs.exists(join(nested, '.git'))) { tryGit(root, ['worktree', 'move', nested, spare]); return false; }
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
  if (environmentAdapter().get('PULLBOARD_RUNNER_JOB')) return false;
  const spare = spareFolderPath(seat);
  if (fs.exists(spare) || indexEntries(root) < SPARE_FROM_FILES) return false;
  // Loaded only when a spare is due, so a claim's import graph stays as it was.
  const { startDetachedCheck } = await import('../../../../../../packages/drive/index.js');
  const started = startDetachedCheck(fileURLToPath(new URL('./scripts/spare.js', import.meta.url)), { args: [root, spare, trunk, ...workers], cwd: root });
  return started !== null;
}
