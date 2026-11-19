/** The changed-line count of a submit against main, and the split note an oversized one prints [V4,C7]. */
import { tryGit } from "../../../../git/index.js";

/** The item size budget in changed lines (added plus deleted) against main; the note appears above twice it. */
export const ITEM_SIZE_BUDGET = 100;

/**
 * Count the changed lines (added plus deleted) the head made since it split from the trunk commit, so changes main
 * gained after the head merged it are not the item's. A binary file reports `-`, so it counts none.
 *
 * @param {string} root the checkout git runs in
 * @param {string} base the trunk commit the submit is compared with
 * @param {string} head the commit being submitted
 * @returns {number | null} null when git cannot compare the two commits
 */
export function changedLines(root, base, head) {
  const result = tryGit(root, ['diff', '--numstat', '--no-renames', `${base}...${head}`]);
  if (result.status !== 0) return null;
  return result.stdout.split('\n').filter(Boolean).reduce((total, line) => {
    const [added, deleted] = line.split('\t');
    return total + (Number(added) || 0) + (Number(deleted) || 0);
  }, 0);
}

/**
 * The one split note for a submit over twice the item budget, or null. It suggests a chain and never blocks,
 * because the submit goes through as usual.
 *
 * @param {number | null} lines the changed-line count from changedLines
 * @param {number} [budget] the board item size budget from accepted main
 * @returns {string | null}
 */
export function oversizeNote(lines, budget = ITEM_SIZE_BUDGET) {
  if (lines === null || lines <= 2 * budget) return null;
  return `this submit changes ${lines} lines against main, over twice the ${budget}-line item budget; consider splitting it into a chain of smaller items. The submit went through as usual.`;
}
