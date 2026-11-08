/** Direct test admission keeps seat ownership separate from gate/verdict capacity [C7,#2831]. */
import { repoInfo } from '../../../git/index.js';

/** Recognize both the CLI test kind and the standalone runner's explicit seat-test kind. */
export function isSeatTest(kind) { return kind === 'test' || kind === 'seat-test'; }

/** Use one shared Git identity across item worktrees while retaining the displayed native agent id. */
export function seatTestRepo(root, fallback) {
  try { return repoInfo(root).commonDir; } catch { return fallback; }
}

/** Read occupied seat test identities from the same transaction that admits local and remote holders. */
export function holdingTestSeats(db) {
  return new Set(db.prepare("SELECT agent, repo FROM holder WHERE (name = 'gate' OR name GLOB 'runner:*') AND kind IN ('test','seat-test')").all()
    .map(holder => JSON.stringify([holder.repo, holder.agent])));
}

const repoRoots = new Map(); // A take asks Git once per directory per process, not once per take [C7,#3084].

/** Resolve the ordinary resource repository without making a non-Git caller an admission failure. */
export function repoRoot(root) {
  if (!repoRoots.has(root)) {
    let found = '';
    try { found = repoInfo(root).root; } catch { /* A non-Git caller holds a lease with no repository. */ }
    repoRoots.set(root, found);
  }
  return repoRoots.get(root);
}

/**
 * How long a seat test waits behind gate work before it ranks first and may take a runner's last free slot (#3431).
 * Half the 60 s admission promise, so the next poll after any slot frees admits it well inside that minute.
 */
export const SEAT_TEST_OVERDUE_MS = 30_000;

/**
 * Rank overdue seat tests ahead of every waiter but landings, and name them so admission lifts the spare-slot
 * reserve for them. Why: a seat test leaves one slot per executor for gates and verdicts (#2831) and ranks in the
 * last queue class, so a steady stream of gate waiters took every slot that freed and a test from an item folder
 * waited to RUNNER_WAIT_DEADLINE while runners showed a free gate slot. Holders are untouched: an overdue test
 * takes only a slot no lease holds. The order is stable, so arrival order holds within each group.
 *
 * @param {Array<{token: string, kind?: string, landing?: number, since?: string}>} line - The gate line in admission order.
 * @param {number} now - The clock reading the whole admission uses.
 * @returns {{ line: object[], overdue: Set<string> }} The reordered line and the overdue seat tests' tokens.
 */
export function overdueSeatTestsFirst(line, now) {
  const overdue = new Set(line.filter(waiter => waiter.landing !== 1 && isSeatTest(waiter.kind)
    && now - Date.parse(waiter.since ?? '') >= SEAT_TEST_OVERDUE_MS).map(waiter => waiter.token));
  if (!overdue.size) return { line, overdue };
  const rank = waiter => waiter.landing === 1 ? 0 : overdue.has(waiter.token) ? 1 : 2;
  return { line: line.map((waiter, index) => ({ waiter, index })).sort((left, right) => rank(left.waiter) - rank(right.waiter) || left.index - right.index)
    .map(entry => entry.waiter), overdue };
}
