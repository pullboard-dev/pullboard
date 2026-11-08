/** Observe dirty primary tooling without granting it execution authority or blocking checks [O5,C7]. */
import { gitSpawnSync } from '../../../git/index.js';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Report one stable warning episode after five minutes; existing health receipts own durable delivery. */
export function dirtyToolingFindings(root, files, now, previous = []) {
  return files.flatMap(file => {
    const key = `PRIMARY_TOOLING_DIRTY:${root}:${file.path}`;
    const prior = previous.find(row => row.key === key);
    const since = prior?.since ?? new Date(file.changedAt).toISOString();
    if (!Number.isFinite(Date.parse(since)) || Number(now) - Date.parse(since) <= 300_000) return [];
    return [{ key, cause: 'PRIMARY_TOOLING_DIRTY', item: null,
      subject: root, title: `uncommitted runner tooling: ${file.path}`, since, owner: { who: 'coordinator' },
      why: `The primary tooling remains dirty; runners continue using committed bytes`,
      next: `review and commit or restore ${file.path}` }];
  });
}

/** Read tracked shipped source dirtiness from the tool repository, never the user's project under test. */
export function observeDirtyRunnerTooling(now, previous = [], root = TOOL_ROOT) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = gitSpawnSync(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (run.status !== 0) return [];
  const files = new Map(), rows = run.stdout.split('\0');
  const indexPath = gitSpawnSync(['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  let indexedAt = Number(now);
  try { const stat = lstatSync(indexPath.stdout.trim()); indexedAt = Math.max(stat.mtimeMs, stat.ctimeMs); } catch { /* A missing index cannot prove an old staged edit. */ }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const paths = [row.slice(3)];
    if (/[RC]/u.test(row.slice(0, 2))) paths.push(rows[++index]);
    for (const path of paths) {
      if (!path || !/^(?:package\.json$|(?:src|bin)\/|apps\/lib\/src\/|packages\/[^/]+\/(?:src\/|(?:index|core)\.js$))/u.test(path)) continue;
      let changedAt;
      try { const stat = lstatSync(join(root, path)); changedAt = Math.max(stat.mtimeMs, stat.ctimeMs); }
      catch {
        // Deletions have no inode clock. A containing-directory change is a conservative later witness.
        try { const stat = lstatSync(dirname(join(root, path))); changedAt = Math.max(stat.mtimeMs, stat.ctimeMs); } catch { continue; }
      }
      if (![' ', '?'].includes(row[0])) changedAt = Math.max(changedAt, indexedAt);
      files.set(path, { path, changedAt });
    }
  }
  return dirtyToolingFindings(root, [...files.values()], now, previous);
}
