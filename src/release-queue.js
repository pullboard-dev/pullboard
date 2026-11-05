/** Capture one board's release priority before joining the machine resource transaction [C7,V4]. */
import { spawnSync } from './windows-child-process.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import {
  boardId,
  openBoardReadOnly,
  roadmap,
} from './board.js';
import {
  cleanGitEnvironment,
  repoInfo,
} from './git.js';

/**
 * Capture the item's roadmap rank once, without opening or migrating a board for writing.
 * The first unfinished local milestone is current; later milestones follow, then completed earlier
 * milestones, then unplanned work. External references are neither counted nor opened. Board identity joins worktrees and local relay replicas of
 * the same board. A checkout with no board has no release identity and keeps its queue position.
 * Why outside resources.js: remote workers ship only its small trusted runtime, not the board.
 *
 * @param {string} root - The gate caller's checkout.
 * @param {string|number} item - The local item id, or empty for an unplanned run.
 * @returns {{ board: string, rank: number }|undefined}
 */
export function captureReleaseQueue(root, item) {
  const file = boardFileFor(root);
  if (!file) return undefined;
  const db = openBoardReadOnly(file);
  try {
    const board = { db, clock: { now: () => new Date() } };
    return { board: boardId(board), rank: localReleaseRank(roadmap(board), item) };
  } finally { db.close(); }
}

/**
 * Find the board database a gate caller queues under: the checkout's own, or, for a private clone of the
 * board repo (a builder's integration clone), the board of the repo it was cloned from. Without a board
 * anywhere the run keeps its queue position, as before [C7,O5].
 *
 * @param {string} root - The gate caller's checkout.
 * @param {number} [hops] - How many clone origins may be followed.
 * @returns {string|null}
 */
function boardFileFor(root, hops = 3) {
  let info;
  try { info = repoInfo(root); } catch { return null; }
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  if (existsSync(file)) return file;
  if (hops <= 0) return null;
  const origin = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  const url = origin.status === 0 ? origin.stdout.trim() : '';
  return url && isAbsolute(url) && existsSync(url) ? boardFileFor(url, hops - 1) : null;
}

/**
 * Rank local work using the board's own verified-item completion. A repo-qualified reference
 * cannot pin this board to an old milestone: its state belongs to another board and is not read.
 *
 * @param {{ items: { id: number|string, status: string }[] }[]} releases - Public roadmap projection.
 * @param {string|number} item - The local item id.
 * @returns {number} Current, later, completed earlier, then unplanned.
 */
export function localReleaseRank(releases, item) {
  const local = releases.map(release => release.items.filter(entry => typeof entry.id === 'number'));
  const first = local.findIndex(items => items.some(entry => entry.status !== 'verified'));
  const current = first < 0 ? 0 : first;
  const ranks = local.flatMap((items, index) => items.some(entry => String(entry.id) === String(item))
    ? [index >= current ? index - current : releases.length + index] : []);
  return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
}
