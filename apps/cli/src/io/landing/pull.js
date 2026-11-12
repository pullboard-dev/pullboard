/**
 * Every landing is one runner land job: accept offers it, and `pullboard land` and `land <ids> --forced` offer the same
 * kind; a runner merges, checks and pushes trunk with compare-and-swap, and its receipt marks the items merged. This
 * host merges nothing and runs no landing batch. With trunk.remote set this holds in any gate.runnerDispatch mode
 * (#5864). With trunk.remote empty the trunk is the board host's own repository, which only a runner on this host
 * reaches, so the job needs the local runner's board-host capability; that path stays behind pull until L6 [P7].
 */
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { configTrunkRemote } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
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
 * itself (no trunk remote of record, and not pull or no local runner). While a land job is open no second automatic
 * one is offered: its receipt settles the items first. Named ids offer only those items; forced (the person's reason)
 * also takes named items not yet accepted, at their submitted commit, and is carried on the job. Each item's commit is
 * pushed to the trunk remote under landingItemRef first, since the runner fetches only from there.
 *
 * @param {object} ctx - The command context at the main checkout.
 * @param {string} root - The main checkout.
 * @param {{ mainPolicy: (root: string) => { config: object, commit: string }, listItems: Function, checkedLandingCommit: Function }} reads - The
 *   policy and board reads the lander already holds.
 * @param {{ local?: typeof ensureLocalRunner, ids?: number[] | null, forced?: string | null, board?: object | null }} [options] - board: the
 *   board a command already holds open, so a hand landing writes its offer there.
 * @returns {Promise<{ offered: string | null, items: number[], waiting: boolean, forced?: string } | null>}
 */
export async function offerPulledLanding(ctx, root, { mainPolicy, listItems, checkedLandingCommit }, { local = ensureLocalRunner, ids = null, forced = null, board: opened = null } = {}) {
  const policy = mainPolicy(root);
  const configured = configTrunkRemote(policy.config);
  // No trunk remote: the board host's repository is trunk, landed by the local runner, which this starts again if it died.
  const hosted = !configured && runnerDispatchMode() === 'pull' && (await local(root)).running;
  if (!configured && !hosted) return null;
  const remote = configured ?? root;
  return (opened ? work => work(opened) : work => withBoard(ctx, work))(board => {
    const open = ids ? null : openLandingJob(board.db);
    if (open) return { offered: open, items: [], waiting: false };
    const all = listItems(board, { all: true });
    for (const id of ids ?? []) if (!all.some(item => item.item_id === id && !item.item_merged_commit)) throw new Refused('LAND_NAMED', `#${id} is not an unmerged item on this board`, 'name only items that wait to land');
    const wanted = item => !item.item_merged_commit && (ids ? ids.includes(item.item_id) && (forced || item.item_status === 'verified') : item.item_status === 'verified' && !item.item_hold_at);
    const items = all.filter(wanted).map(item => ({ id: item.item_id, commit: item.item_status === 'verified' ? checkedLandingCommit(board, item) : item.item_commit, ref: landingItemRef(item.item_id) }));
    if (ids && items.length !== ids.length) throw new Refused('LAND_NOT_ACCEPTED', `${ids.filter(id => !items.some(entry => entry.id === id)).map(id => `#${id}`).join(' ')} is not accepted`, 'land it after its verify, or go around the gate with --forced "<why>"');
    if (!items.length) return { offered: null, items: [], waiting: false };
    for (const entry of items) {
      const pushed = tryGit(root, ['push', '--quiet', '--no-verify', remote, `+${entry.commit}:${entry.ref}`]);
      if (pushed.status !== 0) throw Object.assign(new Error(`could not publish #${entry.id} to the trunk remote: ${(pushed.stderr || pushed.stdout).slice(0, 300)}`), { code: 'LANDING_TRUNK_REMOTE' });
    }
    const listed = tryGit(root, ['ls-remote', '--', remote, TRUNK]);
    const expect = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : policy.commit;
    const job = offerLandingJob(board.db, { items, expect, trunk: TRUNK, forced,
      ...(hosted ? { config: { ...policy.config, trunk: { ...policy.config.trunk, remote } }, needs: [BOARD_HOST], checkout: true } : { config: policy.config }) });
    ctx.io.say?.(`offered ${forced ? 'forced ' : ''}land job ${job.id} for ${items.map(entry => `#${entry.id}`).join(' ')}; a runner merges and pushes trunk`);
    return { offered: job.id, items: items.map(entry => entry.id), waiting: false, ...(forced ? { forced } : {}) };
  });
}
