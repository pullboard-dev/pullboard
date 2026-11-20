/** Whether another seat's item folder is clean and unused, so a claim may adopt it though that seat's session is live [C7,#3720]. */
import { fileSystemAdapter } from '../../../../../../packages/fs/index.js';
import { sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const fs = fileSystemAdapter();

/**
 * Whether any process has `folder` or a directory under it as its working directory.
 * Why: a shell or editor left inside a folder means a person is still using it, so no claim may move it.
 * A machine that cannot run lsof, or whose lsof prints nothing, does not know either way, so it never blocks the claim
 * (runners ship without lsof); any other failure to list counts the folder as in use.
 *
 * @param {string} folder
 * @returns {boolean}
 */
export function processInside(folder) {
  let real;
  try { real = fs.realpath(folder); } catch { return true; }
  const listed = spawnSync('lsof', ['-w', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  // Unknown is not busy: a missing lsof (ENOENT) or empty output says nothing about the folder, and a real listing is never empty.
  if (listed.error?.code === 'ENOENT' || (!listed.error && !listed.stdout)) return false;
  if (listed.error || typeof listed.stdout !== 'string') return true;
  return listed.stdout.split('\n').some(line => line.startsWith('n') && (line.slice(1) === real || line.startsWith(`n${real}${sep}`)));
}

/**
 * True when the item folder has no uncommitted or untracked file, no process inside it, and its item is not claimed by
 * another seat. Anything unreadable counts as in use.
 *
 * @param {any} board
 * @param {{ id: string }} me the claiming seat
 * @param {string} folder the item folder, named `<seat>-item-<id>`
 * @param {(cwd: string, args: string[]) => { status: number|null, stdout: string }} tryGit the caller's Git runner, passed in so this file imports no other cell
 * @returns {boolean}
 */
export function folderIdle(board, me, folder, tryGit) {
  const match = /-item-([1-9]\d*)$/u.exec(folder);
  if (!match || !board) return false;
  const item = board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id = ?').get(Number(match[1]));
  if (item?.item_status === 'claimed' && item.item_owner !== me.id) return false;
  const status = tryGit(folder, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0 || status.stdout.trim()) return false;
  return !processInside(folder);
}
