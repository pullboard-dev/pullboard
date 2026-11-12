/** Item labels: free hand labels plus automatic ones computed from the item, never typed [N2,B13]. */

// An item with this many expected build minutes or fewer is a quick win.
const QUICK_WIN_MINUTES = 10;
const AUTOMATIC = /^(?:lane:|level:|review:strict$|broken-main$|quick-win$)/u;

/**
 * The sorted labels an item carries: its hand labels, plus lane:<name>, level:<value>, review:strict,
 * broken-main and quick-win computed from the item and the context, with no config.
 * Why hand labels never use the automatic names: a typed `review:strict` or `broken-main` would pass as computed
 * truth; such a hand label is dropped, so a label can say what an item is but never grant or deny an agent anything.
 *
 * @param {{ item_lane?: string, item_level?: string, item_review_tier?: string, item_expected_build_minutes?: number | null, item_labels?: string[] }} item
 * @param {{ brokenMain?: boolean }} [context] - Whether the item is a repair for a red main, which the board knows and the item does not.
 * @returns {string[]}
 */
export function itemLabels(item, context = {}) {
  const labels = new Set((item.item_labels ?? []).filter(label => typeof label === 'string' && label && !AUTOMATIC.test(label)));
  if (item.item_lane) labels.add(`lane:${item.item_lane}`);
  if (item.item_level) labels.add(`level:${item.item_level}`);
  if (item.item_review_tier === 'strict') labels.add('review:strict');
  if (context.brokenMain === true) labels.add('broken-main');
  const minutes = item.item_expected_build_minutes;
  if (typeof minutes === 'number' && minutes > 0 && minutes <= QUICK_WIN_MINUTES) labels.add('quick-win');
  return [...labels].sort();
}
