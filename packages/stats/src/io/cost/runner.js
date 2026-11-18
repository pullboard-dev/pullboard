/** An item's runner cost: its check-run runner minutes times each runner's cost per minute [C7]. */
import { runnerMinutes } from '../../logic/runners/minutes.js';

const MS_PER_MINUTE = 60_000;

/**
 * Price an item's check runs: each runner's exact minutes times that runner's cost per minute, summed.
 * Why: the cost of a runner minute is only knowable from the owner's rate card, so a runner with no card
 * has no cost (null), and an item with no priced runner has no runner cost at all: absent, never zero.
 *
 * @param {{ id: string, kind?: string, runner?: string|null, durationMs?: number }[]} receipts - The item's proof receipts.
 * @param {Record<string, number>|undefined} rates - Each runner host's cost per minute (costPerMinute of its rate card); a host with no card is absent.
 * @returns {{ perRunner: { runner: string, minutes: number, costPerMinute: number|null, cost: number|null }[], cost: number|null }}
 */
export function itemRunnerCost(receipts, rates) {
  const perRunner = runnerMinutes(receipts).perRunner.map(({ runner, ms }) => {
    const minutes = ms / MS_PER_MINUTE;
    const rate = rates && Object.hasOwn(rates, runner) && Number.isFinite(rates[runner]) ? rates[runner] : null;
    return { runner, minutes, costPerMinute: rate, cost: rate === null ? null : minutes * rate };
  });
  const priced = perRunner.filter(row => row.cost !== null);
  return { perRunner, cost: priced.length ? priced.reduce((sum, row) => sum + row.cost, 0) : null };
}
