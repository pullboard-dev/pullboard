/** Run the pull-out job of landed sprint work a reject left pulling: revert its landing on trunk and record it pulled [M2,R3,#12181]. */

import { fencedHopEnabled } from '../../../../../packages/config/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { fetchTrunk } from '../../../../../packages/landing/index.js';
import { landingRemote } from '../../../../../packages/landing/index.js';
import { fenceHop } from '../../../../../packages/landing/index.js';
import { pushTrunkThroughFence } from '../../../../../packages/landing/index.js';
import { runPullOutJob } from '../../../../../packages/landing/index.js';
import { pullingLanding } from '../../../../../packages/store/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { withBoard } from '../context.js';
import { primaryCheckoutRoot } from '../worktree.js';

/** The git config this process hands its git children: the pull-out's push runs with no hooks, as a runner's land job push does. */
const NO_HOOKS = Object.freeze({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });

/**
 * A push port (fenceHop or pushTrunkThroughFence) with the checkout's hooks off for that call only.
 * Why: the pull-out pushes its fence and its revert from the board host's main checkout while it holds the board, and that checkout's
 * pre-push hook opens the board and runs the gate, so the push waited on its own lock until the reject command timed out [M2,R3,#12181].
 */
function hookless(push) {
  return (root, options) => {
    const environment = environmentAdapter();
    const before = Object.fromEntries(Object.keys(NO_HOOKS).map(name => [name, environment.get(name)]));
    for (const [name, value] of Object.entries(NO_HOOKS)) environment.set(name, value);
    try { return push(root, options); }
    finally { for (const [name, value] of Object.entries(before)) value === undefined ? environment.delete(name) : environment.set(name, value); }
  };
}

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
  return withBoard(ctx, board => {
    const pulling = ids.filter(item => pullingLanding(board, item));
    // The revert is built on the remote trunk tip, which a runner land job may have pushed after this checkout last fetched.
    // Through the land job's own trunk fetch; a failed fetch leaves each pull-out to refuse PULL_OUT_TRUNK below, logged and run again by the wake.
    if (pulling.length && remote) { try { fetchTrunk(root, remote, `refs/heads/${branch}`); } catch { /* the pull-out names the missing trunk */ } }
    return pulling.map(item => {
      try { return { item, ...runPullOutJob(board, { root, remote, branch, item, fenced: fencedHopEnabled() }, { fenceHop: hookless(fenceHop), pushTrunkThroughFence: hookless(pushTrunkThroughFence) }) }; }
      catch (error) {
        ctx.io.err?.(`pull-out of #${item} not done: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}; the landing wake runs it again`);
        return { item, state: 'failed', error: String(error?.code ?? error?.name ?? 'Error') };
      }
    });
  });
}
