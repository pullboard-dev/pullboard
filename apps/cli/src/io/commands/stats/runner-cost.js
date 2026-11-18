/** Each item's runner cost beside its token cost in `pullboard stats`, only when a runner rate card is set [C7]. */
import { itemRunnerCost } from '../../../../../../packages/stats/index.js';
import { costPerMinute } from '../../../../../../packages/config/index.js';
import { proofReceipts } from '../../../../../../packages/store/index.js';

/**
 * Price every usage item's check runs with the machine's rate cards, keyed by item id.
 * Why: a runner minute is only worth a figure once the owner has set a card, so with no card nothing is added and
 * an item with no priced runner prints no runner cost: absent, never zero.
 *
 * @param {any} board
 * @param {{ item?: string|number }[]} itemRows - The usage rows grouped by item.
 * @param {Record<string, unknown>|undefined} runnerRates - The runnerRates machine setting.
 * @returns {Record<string, { cost: number, perRunner: { runner: string, minutes: number, cost: number|null }[] }>}
 */
export function itemRunnerCosts(board, itemRows, runnerRates) {
  const hosts = Object.keys(runnerRates ?? {});
  if (!hosts.length) return {};
  const rates = Object.fromEntries(hosts.map(host => [host, costPerMinute(runnerRates[host], host)]));
  const out = {};
  for (const row of itemRows) {
    const priced = itemRunnerCost(proofReceipts(board, Number(row.item)), rates);
    if (priced.cost !== null) out[row.item] = priced;
  }
  return out;
}

/** The text to append to an item's usage line, or an empty string when it has no runner cost. */
export function runnerCostText(runnerCosts, item) {
  const found = runnerCosts?.[item];
  if (!found) return '';
  const where = found.perRunner.filter(row => row.cost !== null).map(row => `${row.minutes.toFixed(1)} min on ${row.runner}`).join(', ');
  return `; runner cost USD ${found.cost.toFixed(6)} (${where})`;
}
