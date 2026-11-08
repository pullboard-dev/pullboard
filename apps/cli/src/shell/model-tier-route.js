/** Resolve a declared model through the board's editable tier table, with unknown labels kept at mid.
 *
 * @param {unknown} model
 * @param {{ contains: string, route: string }[]} tiers
 * @returns {'light'|'mid'|'strong'}
 */
export function modelTierRoute(model, tiers) {
  const label = String(model ?? '').trim().toLowerCase();
  if (!label || !Array.isArray(tiers)) return 'mid';
  const matches = tiers.filter(entry => entry && typeof entry.contains === 'string'
    && label.includes(entry.contains.toLowerCase()));
  if (!matches.length) return 'mid';
  const longest = Math.max(...matches.map(entry => entry.contains.length));
  const routes = new Set(matches.filter(entry => entry.contains.length === longest).map(entry => entry.route));
  return routes.size === 1 && ['light', 'mid', 'strong'].includes([...routes][0]) ? [...routes][0] : 'mid';
}
