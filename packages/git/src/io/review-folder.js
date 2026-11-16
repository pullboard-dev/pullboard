import { existsSync } from 'node:fs';
import {
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import {
  cleanGitEnvironment,
  git,
  tryGit,
} from './main.js';
import { addWorktree } from './worktree.js';

/**
 * Give a reviewer a detached worktree at `commit`, fetching the commit from the trunk remote first [C7,#3091].
 * Why: a review reads exactly the submitted commit in its own folder, even when that commit exists only on the trunk
 * remote; a second call for the same commit returns the same folder instead of piling up copies.
 *
 * @param {string} clone - The reviewer's clone of the repository.
 * @param {string} commit - A full commit id that the trunk remote holds.
 * @param {{ remote: string }} options - remote: the trunk.remote URL or remote name to fetch from.
 * @returns {{ folder: string, reused: boolean }} The detached worktree folder and whether it already existed.
 */
export function reviewFolder(clone, commit, { remote }) {
  const env = cleanGitEnvironment();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`reviewFolder needs a full 40-character commit id, got "${commit}"`);
  const common = git(clone, ['rev-parse', '--git-common-dir'], { env });
  const folder = join(isAbsolute(common) ? common : resolve(clone, common), 'pullboard-review', commit);
  if (existsSync(folder)) return { folder, reused: true };
  const held = tryGit(clone, ['cat-file', '-e', `${commit}^{commit}`], { env }).status === 0;
  if (!held) git(clone, ['fetch', '--quiet', remote, commit], { env });
  addWorktree(clone, ['--detach', folder, commit], { env });
  return { folder, reused: false };
}
