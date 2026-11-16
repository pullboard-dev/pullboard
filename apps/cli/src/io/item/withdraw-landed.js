/** The optional withdraw.refuseLanded step: landed work stays landed, so withdraw refuses an item whose commit is on main [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { contains } from '../../../../../packages/git/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';

/**
 * Refuse to withdraw an item whose merged commit, or else its own commit, is on main.
 * Why: a hand lander closed about 240 landed items as withdrawn on 15 Nov, and the roadmap stopped counting them.
 *
 * @param {{ withdraw?: { refuseLanded?: boolean } }} config - off unless withdraw.refuseLanded is true.
 * @param {string} root - the repository root.
 * @param {{ item_id: number, item_merged_commit?: string | null, item_commit?: string | null }} item
 */
export function refuseLandedWithdraw(config, root, item) {
  if (config?.withdraw?.refuseLanded !== true) return;
  const trunk = mainCheckout(root);
  if (!trunk?.commit) return;
  const landed = [item.item_merged_commit, item.item_commit].find(commit => commit && contains(root, commit, trunk.commit));
  if (!landed) return;
  throw new Refused('WITHDRAW_LANDED', `#${item.item_id} is landed: its commit ${landed.slice(0, 12)} is on ${trunk.branch ?? 'main'} at ${trunk.commit.slice(0, 12)}, and landed work is never withdrawn`,
    `pullboard merged ${item.item_id} ${landed.slice(0, 12)} records the landing`);
}
