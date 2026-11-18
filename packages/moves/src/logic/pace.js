/** The pace an item was admitted under, frozen once at its first claim and never read live [V2,M1]. */

/** The paces a board may set; steady is the default and today's landing. */
export const PACES = Object.freeze(['sprint', 'steady', 'strict']);

/**
 * The item's frozen pace, or steady when its bar holds none (frozen before paces, or under steady).
 * Why: an item landed under one pace keeps that pace's rules until it is proven or pulled out, so a setting change never reaches it.
 *
 * @param {{ item_frozen?: string | null } | null | undefined} item
 * @returns {'sprint' | 'steady' | 'strict'}
 */
export function itemPace(item) {
  let frozen = null;
  try { frozen = item?.item_frozen ? JSON.parse(item.item_frozen) : null; } catch { frozen = null; }
  return PACES.includes(frozen?.pace) ? frozen.pace : 'steady';
}

/**
 * The pace a freeze records: the earlier freeze's when the item has one, else the board setting at the first claim.
 * Steady is recorded as nothing, so a steady bar's frozen text and digest stay exactly as before paces.
 *
 * @param {object | null} prior - The item's earlier frozen bar, parsed, or null at its first claim.
 * @param {{ pace?: string } | null | undefined} config - The board's settings, read only when there is no earlier freeze.
 * @returns {'sprint' | 'strict' | null}
 */
export function admittedPace(prior, config) {
  const pace = prior ? prior.pace : config?.pace;
  return pace === 'sprint' || pace === 'strict' ? pace : null;
}
