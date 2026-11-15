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

/**
 * What is wrong with the declared labels in pullboard.json, one sentence per problem, empty when sound.
 * Why strict: a label bound that is not a whole number, or a min above its max, would silently steer nothing.
 *
 * @param {unknown} declared - The `labels` value: { <label>: { min?, max? } }.
 * @returns {string[]}
 */
export function labelDeclarationProblems(declared) {
  if (declared === undefined) return [];
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return ['"labels" is an object of { "<label>": { "min": N, "max": N } } entries; remove it or fix its shape'];
  const problems = [];
  for (const [name, bounds] of Object.entries(declared)) {
    if (!name || !bounds || typeof bounds !== 'object' || Array.isArray(bounds) || Object.keys(bounds).some(key => !['min', 'max'].includes(key))) {
      problems.push(`"labels.${name}" has only "min" and "max"; fix it to { "min": N, "max": N }`);
      continue;
    }
    for (const key of ['min', 'max']) {
      if (bounds[key] !== undefined && (!Number.isSafeInteger(bounds[key]) || bounds[key] < 0)) problems.push(`"labels.${name}.${key}" is a whole number of 0 or more; set it or remove it`);
    }
    if (Number.isSafeInteger(bounds.min) && Number.isSafeInteger(bounds.max) && bounds.min > bounds.max) problems.push(`"labels.${name}" has min ${bounds.min} above max ${bounds.max}; lower the min or raise the max`);
  }
  return problems;
}

/**
 * One row per label, declared or carried: its min and max, the agents holding a claim on an item that carries it,
 * and whether fewer holders than its min leave the minimum unmet.
 * Why from the board alone: the listing is a read; it never changes a claim or an item.
 *
 * @param {Record<string, { min?: number, max?: number }>} declared - The validated `labels` declaration.
 * @param {Array<object>} items - Board items, as listItems returns them.
 * @param {{ brokenMain?: boolean }} [context] - Passed to itemLabels for every item.
 * @returns {{ label: string, min: number | null, max: number | null, holders: string[], unmet: boolean }[]}
 */
export function labelRows(declared, items, context = {}) {
  const holders = new Map(Object.keys(declared ?? {}).map(name => [name, new Set()]));
  for (const item of items) {
    for (const label of itemLabels(item, context)) {
      if (!holders.has(label)) holders.set(label, new Set());
      if (item.item_status === 'claimed' && item.item_owner) holders.get(label).add(item.item_owner);
    }
  }
  return [...holders.keys()].sort().map(label => {
    const { min = null, max = null } = declared?.[label] ?? {};
    const who = [...holders.get(label)].sort();
    return { label, min, max, holders: who, unmet: min !== null && who.length < min };
  });
}
