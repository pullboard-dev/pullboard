import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanGitEnvironment,
  tryGit,
} from "./main.js";
import { addWorktree } from "./worktree.js";

/**
 * The detached review worktree for one commit, created once and reused after [C7,#3091].
 *
 * The commit must already be in the reviewer clone: this helper never runs `git fetch`
 * (fetching belongs to the runner checkout alone). Why: a reviewer reads the exact commit under
 * review, so the folder is keyed by the full commit id and a second call returns the same folder.
 *
 * @param {string} clone - The reviewer clone, a checkout of the repository.
 * @param {string} commit - The full commit id, already present in the clone.
 * @param {string} parent - The folder that holds review folders; each is named for its commit.
 * @returns {{ folder: string, created: boolean }}
 */
export function reviewFolder(clone, commit, parent) {
  const env = cleanGitEnvironment();
  const folder = join(parent, commit);
  if (existsSync(folder)) {
    const head = tryGit(folder, ['rev-parse', 'HEAD'], { env });
    if (head.status === 0 && head.stdout.trim() === commit) return { folder, created: false };
  }
  addWorktree(clone, ['--detach', folder, commit], { env });
  return { folder, created: true };
}
