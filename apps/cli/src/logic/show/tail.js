/** The submitted, review hold, merged and withdrawn lines `pullboard show` prints from the item row, kept pure [C7]. */

/**
 * The item row's tail lines, in the order show prints them. The verdict, receipt and landing lines sit between the groups, so each comes back named.
 *
 * @param {any} item the board's item row
 * @param {{ builderName?: string, reviewerName?: string | null, infra?: { note: string, files: string[] } | null }} facts the display names the caller resolved, and the infra note of the submits
 * @returns {{ before: string[], mergedAs: string | null, withdrawn: string | null }} before: submitted by, checked main merge, infra note and under review by
 */
export function tailLines(item, { builderName = '', reviewerName = null, infra = null } = {}) {
  const before = [];
  if (item.item_commit) before.push(`submitted by ${builderName}${item.item_builder_family ? ` [family ${item.item_builder_family}]` : ''} at ${item.item_commit}`);
  if (item.item_effective_head) before.push(`checked main merge: ${item.item_effective_head} (original submitted source and verdict retained)`);
  if (infra) before.push(`infra note: ${infra.note} (files: ${infra.files.join(', ') || 'none'})`);
  if (reviewerName) before.push(`under review by ${reviewerName} until ${item.item_review_until}`);
  return {
    before,
    mergedAs: item.item_merged_commit ? `merged as ${item.item_merged_commit}` : null,
    withdrawn: item.item_withdrawn_reason ? `withdrawn: ${item.item_withdrawn_reason}` : null,
  };
}
