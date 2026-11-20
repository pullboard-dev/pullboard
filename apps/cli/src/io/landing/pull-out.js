/** Run the pull-out job of landed sprint work a reject left pulling: revert its landing on trunk and record it pulled [M2,R3,#12181]. */

import { fencedHopEnabled } from '../../../../../packages/config/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { landingRemote } from '../../../../../packages/landing/index.js';
import { fenceHop } from '../../../../../packages/landing/index.js';
import { pushTrunkThroughFence } from '../../../../../packages/landing/index.js';
import { runPullOutJob } from '../../../../../packages/landing/index.js';
import { pullingLanding } from '../../../../../packages/store/index.js';
import { withBoard } from '../context.js';
import { primaryCheckoutRoot } from '../worktree.js';

/**
 * Run the pull-out of each item in `ids` whose landing is pulling, from the board host's main checkout, onto the trunk the
 * land jobs push to (trunk.remote, else the branch's remote, as landingRemote names it for a land job). Why here: a reject of landed sprint work
 * wrote pull_out and nothing ran the job, so the work stayed on main. An item whose landing is not pulling is skipped, and
 * a pull-out that fails is logged and left pulling, so the landing wake runs it again.
 *
 * @param {object} ctx - A command context on the board.
 * @param {number[]} ids - The items to pull out.
 * @returns {Promise<Array<{ item: number, state: string, revert?: string, error?: string }>>}
 */
export async function pullOutPulling(ctx, ids) {
  const root = primaryCheckoutRoot(ctx.info) ?? ctx.info.root;
  const branch = mainCheckout(root)?.branch;
  if (!branch || !ids.length) return [];
  const remote = landingRemote(root, branch);
  if (!remote) return [];
  return withBoard(ctx, board => {
    const pulling = ids.filter(item => pullingLanding(board, item));
    // The revert is built on the remote trunk tip, which a runner land job may have pushed after this checkout last fetched.
    if (pulling.length) tryGit(root, ['fetch', '-q', remote, branch]);
    return pulling.map(item => {
      try { return { item, ...runPullOutJob(board, { root, remote, branch, item, fenced: fencedHopEnabled() }, { fenceHop, pushTrunkThroughFence }) }; }
      catch (error) {
        ctx.io.err?.(`pull-out of #${item} not done: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}; the landing wake runs it again`);
        return { item, state: 'failed', error: String(error?.code ?? error?.name ?? 'Error') };
      }
    });
  });
}
