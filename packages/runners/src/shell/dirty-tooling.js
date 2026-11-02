/** Observe dirty primary tooling without granting it execution authority or blocking checks [O5,C7]. */
import { gitSpawnSync } from '../../../git/index.js';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Report one stable warning episode after five minutes; existing health receipts own durable delivery. */
export function dirtyToolingFinding(root, files, now, previous = []) {
  if (!files.length) return null;
  const prior = previous.find(row => row.key === `PRIMARY_TOOLING_DIRTY:${root}`);
  const since = prior?.since ?? new Date(Math.min(...files.map(row => row.changedAt))).toISOString();
  if (!Number.isFinite(Date.parse(since)) || Number(now) - Date.parse(since) <= 300_000) return null;
  const names = files.map(row => row.path).sort().join(', ').slice(0, 4000);
  return { key: `PRIMARY_TOOLING_DIRTY:${root}`, cause: 'PRIMARY_TOOLING_DIRTY', item: null,
    subject: root, title: 'uncommitted runner tooling', since, owner: { who: 'coordinator' },
    why: `Tooling files have remained dirty for more than five minutes: ${names}; runners continue using committed bytes`,
    next: 'review and commit or restore the named tooling files' };
}

/** Read tracked shipped source dirtiness from the tool repository, never the user's project under test. */
export function observeDirtyRunnerTooling(now, previous = [], root = TOOL_ROOT) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = gitSpawnSync(['status', '--porcelain=v1', '-z', '--untracked-files=no'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (run.status !== 0) return [];
  const files = [], rows = run.stdout.split('\0');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const path = row.slice(3);
    if (/[RC]/u.test(row.slice(0, 2))) index++;
    if (!/^(?:package\.json$|(?:src|bin)\/|packages\/[^/]+\/(?:src\/|(?:index|core)\.js$))/u.test(path)) continue;
    let changedAt;
    try { changedAt = lstatSync(join(root, path)).mtimeMs; }
    catch {
      // Deletions have no inode clock. A containing-directory change is a conservative later witness.
      try { changedAt = lstatSync(dirname(join(root, path))).mtimeMs; } catch { continue; }
    }
    files.push({ path, changedAt });
  }
  const finding = dirtyToolingFinding(root, files, now, previous);
  return finding ? [finding] : [];
}
