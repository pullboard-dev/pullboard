/** The optional withdraw.refuseLanded step: landed work stays landed, so withdraw refuses an item whose commit is on main [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';

/**
 * Refuse to withdraw an item whose merged commit, or else its own commit, is on main (roadmap's isLanded).
 * Why: a hand lander closed about 240 landed items as withdrawn on 15 Nov, and the roadmap stopped counting them.
 *
 * @param {{ withdraw?: { refuseLanded?: boolean } }} config - off unless withdraw.refuseLanded is true.
 * @param {string} root - the repository root.
 * @param {{ item_id: number, item_merged_commit?: string | null, item_commit?: string | null }} item
 * @param {{ isLanded: Function, landedOnMain: Function }} roadmap - the roadmap cell's landed fact, passed in by the command that already holds that cell.
 */
export function refuseLandedWithdraw(config, root, item, { isLanded, landedOnMain } = {}) {
  if (config?.withdraw?.refuseLanded !== true) return;
  // The same fact roadmap and show read (isLanded), always from git main here: this setting is about main, not landing.landedFromMain.
  const onMain = landedOnMain(root, { landing: { landedFromMain: true } });
  if (!onMain || !isLanded(item, onMain)) return;
  const landed = [item.item_merged_commit, item.item_commit].find(commit => commit && onMain(commit));
  throw new Refused('WITHDRAW_LANDED', `#${item.item_id} is landed: its commit ${landed.slice(0, 12)} is on main, and landed work is never withdrawn`,
    `pullboard merged ${item.item_id} ${landed.slice(0, 12)} records the landing`);
}
