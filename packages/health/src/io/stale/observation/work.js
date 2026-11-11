import { gitSpawnSync } from '../../../../../git/index.js';
import { staleRunQuiet } from './run.js';
/** Capture actual local work without changing any checkout; replicas consume only the captured observation [B4,C7]. */
import { lstatSync } from 'node:fs';
import {
  dirname,
  resolve,
  sep,
} from 'node:path';
import {
  cleanGitEnvironment,
  tryGit,
} from '../../../../../git/index.js';

/** Observe commit and changed-file times in a registered holder's real worktree; missing data stays unavailable. */
export function observeStaleWork(board, actor) {
  const seat = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(actor);
  if (!seat?.agent_path) return { available: false, at: null };
  return observeStaleWorkAt(resolve(seat.agent_path));
}

/** Observe one validated native worktree without resolving a seat or manufacturing a missing commit. */
export function observeStaleWorkAt(root) {
  if (!staleRunQuiet(root)) return { available: false, at: null };
  try {
    const env = cleanGitEnvironment();
    const commit = tryGit(root, ['log', '-1', '--format=%cI', 'HEAD'], { env });
    const reflog = tryGit(root, ['rev-parse', '--git-path', 'logs/HEAD'], { env });
    const changed = gitSpawnSync(['ls-files', '--modified', '--others', '--exclude-standard', '-z'],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (commit.status !== 0 || reflog.status !== 0 || changed.status !== 0) return { available: false, at: null };
    let latest = Math.max(Date.parse(commit.stdout.trim()), lstatSync(resolve(root, reflog.stdout)).mtimeMs);
    if (!Number.isFinite(latest)) return { available: false, at: null };
    const files = (changed.stdout ?? '').split('\0').filter(Boolean);
    if (files.length > 10_000) return { available: false, at: null };
    for (const file of files) {
      const path = resolve(root, file);
      if (!path.startsWith(root + sep)) return { available: false, at: null };
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; stat = lstatSync(dirname(path)); }
      latest = Math.max(latest, stat.mtimeMs);
    }
    return { available: true, at: new Date(latest).toISOString(), commitAt: new Date(Date.parse(commit.stdout.trim())).toISOString() };
  } catch { return { available: false, at: null }; }
}
