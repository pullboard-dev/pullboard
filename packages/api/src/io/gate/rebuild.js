/** Rebuild a gate candidate on the trunk head with Git alone: a merge commit of the trunk and the candidate, or the files that conflict [C7,#12165]. */
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { repoInfo } from '../../../../git/index.js';
import { trunkRevisionReader } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';

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

/**
 * The gate's candidate rebuilt on the trunk head, when the gate passed its checks, the board has a trunk port and the trunk head is not in the candidate; else null (the shards run at the candidate and base as offered).
 * Why: a proof run on a candidate that lacks what trunk gained since the claim judges a tree that never lands [C7,#12165].
 * An unreadable head or a Git failure also give null. A conflict gives { returned } instead: returnConflicted's answer, with no candidate [#12411].
 * The shards run at the rebuilt commit; the gate job keeps the candidate it judged.
 */
export function rebuiltOnTrunk(board, offered, receipt, { trunk = null, job = null } = {}) {
  const root = board.gitRoot;
  if (typeof trunk !== 'function' || !root || receipt?.status !== 0 || (receipt.gate?.phases ?? []).some(phase => phase.status !== 0)) return null;
  try {
    const head = trunkRevisionReader(repoInfo(root))();
    if (!OBJECT_ID.test(String(head ?? '')) || tryGit(root, ['merge-base', '--is-ancestor', head, offered.candidate]).status !== 1) return null;
    const built = rebuildOnTrunk(root, { trunk: head, commit: offered.candidate });
    return built.commit ? { candidate: built.commit, main: head } : { returned: returnConflicted(board, { job, offered, conflicts: built.conflicts, main: head }) };
  } catch { return null; }
}

/**
 * Give a gate candidate that conflicts with the trunk head back to its builder: a fact naming each conflicting file, in the wording a land
 * conflict's return uses, and a shout. The gate job offers no shard and ends here.
 * Why: shards run on a rebuilt candidate, and one that cannot be rebuilt would only be judged on a tree that never lands [C7,#12411].
 */
function returnConflicted(board, { job, offered, conflicts, main }) {
  const { item: id, candidate, submit } = offered;
  const why = `gate job ${job} could not merge candidate ${candidate.slice(0, 12)} onto trunk ${String(main).slice(0, 12)}: conflicts in ${conflicts.slice(0, 40).join(', ') || 'no file named'}`.slice(0, 400);
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `${why}; merge current main, resolve the conflict, commit and resubmit` });
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id, text: `#${id} is back with you: ${why}`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: 'conflict', conflicts };
}
