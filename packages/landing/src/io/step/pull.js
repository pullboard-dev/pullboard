/** The pull-out job: revert a pulling item's landed commit on trunk, push it through the hop fence, then record the item pulled [M2,R3,#9099]. */
import { tryGit } from '../../../../git/index.js';
import { createJob } from '../../../../jobs/index.js';
import { finishJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { Refused } from '../../../../kernel/index.js';
import { pullingLanding } from '../../../../store/index.js';
import { recordPulled } from '../../../../store/index.js';
import { carryLandingHops } from '../land/fence.js';
import { requireCarriedHops } from '../land/fence.js';
import { revertLanded } from './revert.js';

/** The job kind, as JOB_KINDS in the moves backbone table names it. */
export const PULL_OUT_KIND = 'pull-out';

/** One pull-out job per item and landed commit, so a second driver finds the first one's row. */
export function pullOutJobId(item, mergedCommit) {
  return `${PULL_OUT_KIND}:${item}:${mergedCommit.slice(0, 12)}`;
}

/**
 * The commit the remote's trunk names now, which `root` must already hold so a revert can be built on it.
 * Why no fetch here: the runner's checkout entry point is the one place that fetches; the lander's checkout already tracks trunk.
 */
function remoteTrunk(root, remote, branch) {
  // No trunk remote: the board host's own repository is trunk, so its branch tip is the trunk the revert builds on.
  if (!remote) {
    const local = tryGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch.replace(/^refs\/heads\//u, '')}^{commit}`]).stdout;
    if (!local) throw new Refused('PULL_OUT_TRUNK', `${branch} names nothing in this repository`, 'check out the trunk branch in the board host checkout, then run the pull-out again');
    return local;
  }
  const tip = tryGit(root, ['ls-remote', remote, branch]).stdout.split(/\s+/u)[0];
  if (!tip || tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status !== 0) {
    throw new Refused('PULL_OUT_TRUNK', `${branch} on ${remote} names ${tip ? tip.slice(0, 12) : 'nothing'}, which this checkout does not hold`, 'fetch the trunk into the lander\'s checkout, then run the pull-out again');
  }
  return tip;
}

/**
 * Run item `item`'s pull-out: only when its landing is pulling, create the pull-out job, revert its landed commit on the
 * remote trunk tip, push the revert through the fence under the item's hop epoch, then record the item pulled at that revert.
 * A revert that conflicts records the job blocked, naming the conflicted paths, and records nothing on the item, so its landing stays pulling.
 * Why only pulling: only a Sprint item ever reaches pulling, so a Steady board never creates this job and its replay is unchanged.
 * Why the hop epoch: the same fence every landing push carries keeps a stale owner from moving trunk under a newer one [C7,#8275].
 * Why the push is a port: publish.js is the one move-trunk entry point, and importing it here would pull the gate and CLI into this file's reach.
 *
 * @param {any} board - The open board; its db holds the job rows unless `jobs` names the runs file.
 * @param {{ root: string, remote: string | null, branch: string, item: number, agentId?: string, fenced?: boolean,
 *   jobs?: import('node:sqlite').DatabaseSync, now?: () => number }} options - root: a checkout of the repository; fenced: gate.fencedHop.
 * @param {{ fenceHop: Function, pushTrunkThroughFence: Function }} ports - publish.js's fenceHop and pushTrunkThroughFence, passed in by the lander.
 * @returns {{ state: 'skipped' } | { state: 'blocked', job: string, conflicts: string[], trunk: string } | { state: 'pulled', job: string, revert: string, trunk: string }}
 */
export function runPullOutJob(board, { root, remote, branch, item, agentId = 'coordinator', fenced = true, jobs = board.db, now = Date.now }, { fenceHop, pushTrunkThroughFence } = {}) {
  if (typeof fenceHop !== 'function' || typeof pushTrunkThroughFence !== 'function') {
    throw new Refused('PULL_OUT_PUSH_PORT', 'a pull-out pushes through the fence', 'pass { fenceHop, pushTrunkThroughFence } from packages/landing/src/io/step/publish.js');
  }
  const pulling = pullingLanding(board, item);
  if (!pulling) return { state: 'skipped' };
  const id = pullOutJobId(item, pulling.mergedCommit);
  const trunk = remoteTrunk(root, remote, branch);
  createJob(jobs, { id, kind: PULL_OUT_KIND, item, candidate: pulling.mergedCommit, base: trunk, now: now() });
  const reverted = revertLanded(root, pulling.mergedCommit, trunk);
  if ('conflicts' in reverted) {
    writeStep(jobs, id, 'blocked', { conflicts: reverted.conflicts, trunk, reason: `the revert of ${pulling.mergedCommit.slice(0, 12)} conflicts on ${trunk.slice(0, 12)} in ${reverted.conflicts.join(', ')}` }, { now: now() });
    return { state: 'blocked', job: id, conflicts: reverted.conflicts, trunk };
  }
  writeStep(jobs, id, 'reverted', { revert: reverted.commit, trunk }, { now: now() });
  // With no remote there is no fence to move: the host's own trunk takes the revert as a fast-forward, the way its local runner lands into it.
  const hops = remote ? carryLandingHops(board.db, [{ id: item }], { enabled: fenced }) : [];
  if (remote) requireCarriedHops(board.db, hops);
  for (const hop of hops) fenceHop(root, { remote, ...hop });
  const pushed = remote ? pushTrunkThroughFence(root, { remote, branch, base: trunk, tip: reverted.commit, hops })
    : tryGit(root, ['merge', '--ff-only', '--quiet', reverted.commit]);
  if (pushed.status !== 0) {
    throw new Refused('PULL_OUT_PUSH', `the revert ${reverted.commit.slice(0, 12)} for #${item} could not be pushed to ${branch}: ${(pushed.stderr || pushed.stdout).split('\n')[0]}`,
      'trunk moved or the remote refused; run the pull-out again to revert on the new tip');
  }
  writeStep(jobs, id, 'pushed', { revert: reverted.commit, hops }, { now: now() });
  recordPulled(board, item, { agentId, revert: reverted.commit });
  finishJob(jobs, id, null, { now: now() });
  return { state: 'pulled', job: id, revert: reverted.commit, trunk };
}
