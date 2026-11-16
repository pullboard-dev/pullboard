/** Opted-in submission proofs run a committed composition with the pinned current trunk [M1,V4]. */
import { contains } from "../../../../git/index.js";
import { git } from "../../../../git/index.js";
import { headCommitOf } from "../../io/submit/revs.js";
import { Refused } from "../../../../kernel/index.js";

/**
 * Refuse before execution, and again after it, if the exact main snapshot was not proved.
 *
 * A hotfix head that already sits in main's history (an ancestor of the proved main, not its tip) is measured against
 * its own parent: when `parentBase` (submissionSize.base) is that head's parent, nothing is left to compose, because
 * the head cannot contain a main that came after it. Any other head must contain main as before (#9445).
 */
export function requireSubmitComposition(root, candidate, trunk, expectedMain, parentBase = null) {
  if (trunk.commit !== expectedMain) throw notComposed(trunk);
  if (contains(root, trunk.commit, candidate)) return;
  if (parentBase && contains(root, candidate, trunk.commit) && parentOf(root, candidate) === parentBase) return;
  throw notComposed(trunk);
}

/** The refusal shared by every way a submission can miss the proved main. */
function notComposed(trunk) {
  return new Refused('MAIN_NOT_COMPOSED', `the submission must contain current main ${trunk.commit.slice(0,12)} and prove that same snapshot; merge main into this worktree, commit the composition, then run pullboard submit <id> again`);
}

/** The first parent of a commit, or null for a root commit. */
function parentOf(root, commit) {
  try { return git(root, ['rev-parse', `${commit}^`]).trim(); } catch { return null; }
}

const MAX_MOVES = 5;

/**
 * Keep a finished proof when main moved during it through commits that touch nothing the proof depends on (#1816).
 *
 * Main lands every few minutes and a composed proof takes several, so requiring the exact proved main at the end
 * refused good submissions over unrelated landings. When main moved from the pinned `proved` main to `readTrunk()`,
 * every moved file is judged: none may be a file the item changes, a file its frozen check runs, or a file that one of
 * its affected tests reads. If all are untouched, the new main is merged into the worktree without rerunning the proof,
 * re-judging any further move, and the merge and its evidence are returned; any overlap refuses and names every
 * overlapping file. A move that is not a fast-forward of the proved main refuses as before.
 *
 * @param {string} root the submitting worktree
 * @param {{ id: number, proofCommit: string, proved: string, item: any, check: string|null, readTrunk: () => { commit: string } }} proof
 * @param {{ selectAffectedTests: Function, explicitCheckFiles: Function, onMergeFailure?: (error: Error) => void }} services
 * @returns {Promise<{ commit: string, evidence: null | { proofCommit: string, merge: string, from: string, to: string, moved: string[] } }>}
 */
export async function composeAfterProof(root, { id, proofCommit, proved, item, check, readTrunk }, services) {
  let trunk = readTrunk();
  if (trunk.commit === proved) return { commit: proofCommit, evidence: null };
  let head = proofCommit, from = proved;
  const moved = [];
  for (let round = 0; round < MAX_MOVES; round += 1) {
    if (!contains(root, from, trunk.commit)) {
      throw new Refused('MAIN_NOT_COMPOSED', `main moved from ${from.slice(0, 12)} to ${trunk.commit.slice(0, 12)}, which does not contain the proved main; merge main into this worktree, commit the composition, then run pullboard submit <id> again`);
    }
    const judged = await services.judgeTrunkMove(root, { from, to: trunk.commit, item, checkedCommit: proofCommit, check }, services, { all: true });
    if (judged.overlaps.length) {
      throw new Refused('MAIN_NOT_COMPOSED', `main moved from ${proved.slice(0, 12)} to ${trunk.commit.slice(0, 12)} during the submission proof and changed what the proof depends on: ${judged.overlaps.join('; ')}; merge main into this worktree, commit the composition, then run pullboard submit <id> again`);
    }
    moved.push(...judged.moved);
    try {
      git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge main ${trunk.commit.slice(0, 12)} into #${id} after its proof; the main move touched none of its files`, trunk.commit]);
    } catch (error) {
      services.onMergeFailure?.(error);
      try { git(root, ['merge', '--abort']); } catch { /* Nothing was left to abort; the refusal below names the failed merge. */ }
      throw new Refused('MAIN_NOT_COMPOSED', `main moved to ${trunk.commit.slice(0, 12)} during the submission proof and merging it failed (${String(error.stderr || error.message).trim().split('\n')[0]}); merge main into this worktree, commit the composition, then run pullboard submit <id> again`);
    }
    head = headCommitOf(root);
    const now = readTrunk();
    if (now.commit === trunk.commit) {
      return { commit: head, evidence: { proofCommit, merge: head, from: proved, to: trunk.commit, moved } };
    }
    from = trunk.commit;
    trunk = now;
  }
  throw new Refused('MAIN_NOT_COMPOSED', `main kept moving during the submission (${MAX_MOVES} landings); run pullboard submit <id> again`);
}

/** The one native fact that records the merge with the evidence that the main move touched none of the proof's files. */
export function trunkMoveFact(evidence) {
  return `main moved during the submission proof from ${evidence.from.slice(0, 12)} to ${evidence.to.slice(0, 12)} through ${evidence.moved.map(sha => sha.slice(0, 12)).join(', ')}; `
    + `none of those commits changes a file this item changes, a file its frozen check runs or a file its affected tests read, so the proof at ${evidence.proofCommit.slice(0, 12)} stands without a rerun, `
    + `and submit merged the new main as ${evidence.merge.slice(0, 12)}`;
}
