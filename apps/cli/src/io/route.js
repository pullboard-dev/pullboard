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

/**
 * The route a seat serves for the session now running in it [#3678]: its joined route, lowered to the join rule's
 * route for the model this session declares (PULLBOARD_MODEL) when that model differs from the one the seat joined
 * with. Why: Light-route sessions started in seats mid-route models joined on the strong route were handed strong items. The joined
 * model keeps the joined route, so an explicit join --route still holds, and declaring it again restores the route.
 * A label the tier table does not name lowers nothing: it says no more about the model than the join did.
 *
 * @param {string} seatRoute the route the seat joined on
 * @param {unknown} seatModel the model the seat joined with
 * @param {unknown} declaredModel the model this session declares, if any
 * @param {{ contains: string, route: string }[]} tiers
 * @returns {string}
 */
export function sessionRoute(seatRoute, seatModel, declaredModel, tiers) {
  const declared = String(declaredModel ?? '').trim();
  if (!declared || declared === String(seatModel ?? '').trim()) return seatRoute;
  const label = declared.toLowerCase();
  if (!Array.isArray(tiers) || !tiers.some(entry => typeof entry?.contains === 'string' && label.includes(entry.contains.toLowerCase()))) return seatRoute;
  const order = ['light', 'mid', 'strong'];
  const route = modelTierRoute(declared, tiers);
  return order.includes(seatRoute) && order.indexOf(route) < order.indexOf(seatRoute) ? route : seatRoute;
}
