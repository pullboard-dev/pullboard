import { join } from 'node:path';
import { hookStanding } from '../logic/hook-compat.js';
import { activeHooksDir } from './hooks.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const fs = fileSystemAdapter();

/**
 * Name hooks installed by an older release, and the one step that refreshes them (#7760, R4).
 *
 * Hooks one release back still run, because the newer binary answers their version probe; they are reported so the
 * refresh happens before the next release stops them. Older ones refuse every commit, so they are reported first.
 * `init` refuses a worktree, so the step names the main checkout.
 *
 * @param {string} root
 * @param {string} release This release.
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function staleHookProblems(root, release) {
  const dir = activeHooksDir(root);
  if (!fs.exists(dir)) return [];
  const scripts = fs.list(dir).map((name) => { try { return fs.readFile(join(dir, name), 'utf8'); } catch { return ''; } });
  const { state, versions } = hookStanding(release, scripts);
  if (state === 'none' || state === 'current') return [];
  const verdict = state === 'accepted' ? 'still run, but the next release will refuse them' : `are refused by Pullboard ${release} and stop every commit`;
  return [{ code: 'HOOKS_OLDER_RELEASE', message: `git hooks were installed by Pullboard ${versions.join(' and ')}, and ${verdict}`,
    next: 'in the main checkout run pullboard init, commit the .githooks changes, then merge main into each seat' }];
}
