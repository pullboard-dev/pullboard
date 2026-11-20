/** Rebuild a gate candidate on the trunk head with Git alone: a merge commit of the trunk and the candidate, or the files that conflict [C7,#12165]. */
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * The candidate merged onto the trunk head, built without touching the work tree, the index or any ref.
 * Why: a gate that must run on current trunk needs the merged commit named before any job is offered, and a conflict is named by its files.
 *
 * @param {string} root - A repository holding both commits.
 * @param {{ trunk: string, commit: string }} heads - The trunk head and the candidate commit.
 * @returns {{ commit: string } | { conflicts: string[] }} The new commit (parents: the candidate, then the trunk) whose tree is what `git merge-tree --write-tree` gives, or the sorted conflicting paths with no commit made.
 */
export function rebuildOnTrunk(root, { trunk, commit }) {
  const merged = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', trunk, commit]);
  const parts = merged.stdout.split('\0');
  if (merged.status === 1) {
    const names = [];
    for (const part of parts.slice(1)) { if (!part) break; names.push(part); }
    return { conflicts: [...new Set(names)].sort() };
  }
  const tree = (parts[0] ?? '').trim();
  if (merged.status !== 0 || !OBJECT_ID.test(tree)) throw new Error(`git merge-tree failed: ${merged.stderr || merged.stdout}`.slice(0, 400));
  return { commit: git(root, ['commit-tree', tree, '-p', commit, '-p', trunk, '-m', `Merge ${trunk.slice(0, 12)} onto the gate candidate`]) };
}
