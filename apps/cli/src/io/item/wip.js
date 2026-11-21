/** Snapshot an item folder's work to refs/pullboard/wip/<item> without touching the builder's index, HEAD or files [C7,#12568]. */
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { git } from '../../../../../packages/git/index.js';
import { checkoutRefCommit } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';

/** The identity of a snapshot commit: it is the board's record, never the builder's authorship. */
const IDENTITY = { GIT_AUTHOR_NAME: 'pullboard', GIT_AUTHOR_EMAIL: 'pullboard@localhost', GIT_COMMITTER_NAME: 'pullboard', GIT_COMMITTER_EMAIL: 'pullboard@localhost' };

/** The ref a snapshot of an item lands on. */
export const wipRef = item => `refs/pullboard/wip/${item}`;

/** A git path of the folder (index, index.lock), absolute, worktree-aware. */
function gitFile(folder, name) {
  const path = git(folder, ['rev-parse', '--git-path', name]);
  return isAbsolute(path) ? path : resolve(folder, path);
}

/**
 * Save the folder's staged, unstaged and untracked work as a commit on refs/pullboard/wip/<item>, through a temporary
 * index so the builder's own index (bytes and mtime), HEAD and status stay as they were. Why: a seat that goes away
 * loses its uncommitted work (#12535); the board keeps a copy it can restore.
 *
 * @param {string} folder - The item folder.
 * @param {number|string} item - The item id.
 * @returns {{ written: boolean, commit: string|null, reason?: string }} Whether a new commit was written; reason is 'locked' or 'unchanged' when not.
 */
export function snapshotWip(folder, item) {
  const lock = `${gitFile(folder, 'index')}.lock`;
  if (existsSync(lock)) return { written: false, commit: null, reason: 'locked' };
  const ref = wipRef(item);
  try {
    const index = gitFile(folder, 'index');
    const temporary = gitFile(folder, `wip-index-${process.pid}`);
    if (existsSync(index)) copyFileSync(index, temporary);
    const env = { ...process.env, ...IDENTITY, GIT_INDEX_FILE: temporary };
    git(folder, ['add', '-A'], { env });
    if (existsSync(lock)) return { written: false, commit: null, reason: 'locked' };
    const tree = git(folder, ['write-tree'], { env });
    const previous = tryGit(folder, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    const parent = previous.status === 0 ? previous.stdout : null;
    if (parent && git(folder, ['rev-parse', `${parent}^{tree}`]) === tree) return { written: false, commit: parent, reason: 'unchanged' };
    const commit = git(folder, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `wip snapshot of #${item}`], { env });
    git(folder, ['update-ref', ref, commit, ...(parent ? [parent] : [])]);
    return { written: true, commit };
  } finally {
    rmSync(gitFile(folder, `wip-index-${process.pid}`), { force: true });
  }
}

/**
 * Restore the item's last wip snapshot into a freshly made folder as uncommitted work on top of the branch, when the
 * snapshot is newer than the branch head. Nothing is committed: the builder decides what to keep. Why: a re-offered
 * item started from the bare branch and lost the dead seat's uncommitted work (#12535).
 *
 * @param {string} folder - The new item folder, with the item branch checked out.
 * @param {number|string} item - The item id.
 * @returns {boolean} Whether a snapshot was restored.
 */
export function restoreWip(folder, item) {
  const snapshot = checkoutRefCommit(folder, wipRef(item));
  if (!snapshot) {
    if (snapshot === null) return false;
    if (tryGit(folder, ['rev-parse', '--verify', '-q', `${wipRef(item)}^{commit}`]).status !== 0) return false;
  }
  const times = tryGit(folder, ['show', '-s', '--format=%ct', wipRef(item), 'HEAD']);
  if (times.status !== 0) return false;
  const [taken, head] = times.stdout.split(/\s+/u).map(Number);
  if (!(taken > head)) return false;
  const patch = gitFile(folder, `wip-restore-${process.pid}`);
  try {
    if (tryGit(folder, ['diff', '--binary', `--output=${patch}`, 'HEAD', wipRef(item)]).status !== 0) return false;
    return tryGit(folder, ['apply', '--binary', patch]).status === 0;
  } finally {
    rmSync(patch, { force: true });
  }
}
