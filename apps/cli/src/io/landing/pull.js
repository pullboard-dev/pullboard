/**
 * Under gate.runnerDispatch pull, the automatic lander offers accepted items as one runner land job and returns: a
 * runner merges, checks and pushes trunk with compare-and-swap, and its receipt marks the items merged. This host
 * merges nothing and runs no landing batch. With trunk.remote empty the trunk is the board host's own repository,
 * which only a runner on this host reaches, so the job needs the local runner's board-host capability [P7].
 */
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { configTrunkRemote } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { withBoard } from '../context.js';
import { BOARD_HOST } from '../runner/local.js';
import { ensureLocalRunner } from '../runner/local.js';

const TRUNK = 'refs/heads/main';

/** The ref an accepted item's commit is published under on the trunk remote, so a runner can fetch it by name. */
export function landingItemRef(id) {
  return `refs/pullboard/land/${id}`;
}

/**
 * Offer the board's accepted, unmerged, unheld items as one land job, or return null when this machine lands them
 * itself (not pull, or no trunk remote of record and no local runner). While a land job is open no second one is
 * offered: its receipt settles the items first. Each item's commit is pushed to the trunk remote under landingItemRef
 * first, since the runner fetches only from there.
 *
 * @param {object} ctx - The command context at the main checkout.
 * @param {string} root - The main checkout.
 * @param {{ mainPolicy: (root: string) => { config: object, commit: string }, listItems: Function, checkedLandingCommit: Function }} reads - The
 *   policy and board reads the lander already holds.
 * @returns {Promise<{ offered: string | null, items: number[], waiting: boolean } | null>}
 */
export async function offerPulledLanding(ctx, root, { mainPolicy, listItems, checkedLandingCommit }, { local = ensureLocalRunner } = {}) {
  if (runnerDispatchMode() !== 'pull') return null;
  const policy = mainPolicy(root);
  const configured = configTrunkRemote(policy.config);
  // No trunk remote: the board host's repository is trunk, landed by the local runner, which this starts again if it died.
  const hosted = !configured && (await local(root)).running;
  if (!configured && !hosted) return null;
  const remote = configured ?? root;
  return withBoard(ctx, board => {
    const open = openLandingJob(board.db);
    if (open) return { offered: open, items: [], waiting: false };
    const items = listItems(board, { all: true }).filter(item => item.item_status === 'verified' && !item.item_merged_commit && !item.item_hold_at)
      .map(item => ({ id: item.item_id, commit: checkedLandingCommit(board, item), ref: landingItemRef(item.item_id) }));
    if (!items.length) return { offered: null, items: [], waiting: false };
    for (const entry of items) {
      const pushed = tryGit(root, ['push', '--quiet', '--no-verify', remote, `+${entry.commit}:${entry.ref}`]);
      if (pushed.status !== 0) throw Object.assign(new Error(`could not publish #${entry.id} to the trunk remote: ${(pushed.stderr || pushed.stdout).slice(0, 300)}`), { code: 'LANDING_TRUNK_REMOTE' });
    }
    const listed = tryGit(root, ['ls-remote', '--', remote, TRUNK]);
    const expect = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : policy.commit;
    const job = offerLandingJob(board.db, { items, expect, mode: 'pull', trunk: TRUNK,
      ...(hosted ? { config: { ...policy.config, trunk: { ...policy.config.trunk, remote } }, needs: [BOARD_HOST], checkout: true } : { config: policy.config }) });
    ctx.io.say?.(`offered land job ${job.id} for ${items.map(entry => `#${entry.id}`).join(' ')}; a runner merges and pushes trunk`);
    return { offered: job.id, items: items.map(entry => entry.id), waiting: false };
  });
}
