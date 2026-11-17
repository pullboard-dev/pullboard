/** With next.routeByTier on, next offers an item only to a seat on the tier the project's tiers route it to [C7,#8800,#2178]. */
import { agentModel } from '../../../store/index.js';
import { itemThread } from '../../../store/index.js';
import { itemTierPin } from '../../../seats/index.js';
import { bouncesAtTier } from '../../../seats/index.js';
import { routeByTier } from '../../../seats/index.js';

/** A model label as the tiers setting and a seat's join spell it: trimmed, lower case, one hyphen for each run of spaces. */
const label = model => String(model ?? '').trim().toLowerCase().replace(/[\s_]+/gu, '-');

/**
 * The open items this seat is not offered because their tier is not the seat's own.
 * An item's tier is its pin, or the escalation tier after two bounces at the routine tier, or the routine tier (routeByTier).
 * Why: a seat on an unknown model, or a project with no matching tier, is left unfiltered, so a setting never strands work.
 *
 * @param {{ tiers?: Record<string, { model: string }> }} config The project config.
 * @param {any} board
 * @param {any[]} items Every item of the board.
 * @param {{ id: string }} me The asking seat.
 * @returns {number[]} The item ids to leave out of this seat's pick.
 */
export function tierOmissions(config, board, items, me) {
  const tiers = config.tiers;
  if (!tiers || typeof tiers !== 'object') return [];
  const model = label(agentModel(board, me.id));
  const seatTier = Object.keys(tiers).find(name => label(tiers[name]?.model) === model);
  if (!model || !seatTier) return [];
  const omitted = [];
  for (const item of items) {
    if (item.item_status !== 'open') continue;
    const thread = itemThread(board, item.item_id);
    const pin = itemTierPin(thread);
    const routed = routeByTier(tiers, { ...(pin ? { tier: pin } : {}), bounces: bouncesAtTier(thread, pin ?? 'routine') });
    if (routed && routed.tier !== seatTier) omitted.push(item.item_id);
  }
  return omitted;
}
