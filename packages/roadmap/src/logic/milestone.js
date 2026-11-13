/** Named milestone preference reads only recorded board policy and preserves each group's existing order [N2,B16,H16]. */
import { engineAtLeast } from "../../../state/light.js";
import { FOCUS_MILESTONE_ENGINE } from "../../../state/light.js";
import { MAIN_RED_FOCUS_ENGINE } from "../../../state/light.js";
import { lineSettings } from "../../../state/light.js";

/**
 * Unfinished Main red items, which count as in focus whatever milestone holds them, or none. Why: a Main red blocks
 * every landing, so a focus with overflow off that hid it left seats idle while landing stayed stuck (#3126).
 */
function mainRedIds(board) {
  if (!engineAtLeast(board, MAIN_RED_FOCUS_ENGINE)) return [];
  return board.db.prepare("SELECT item_id FROM item WHERE (item_title GLOB 'Main red:*' OR item_title GLOB 'Red cluster:*') AND item_status IN ('open','claimed','submitted')").all().map(row => row.item_id);
}

/** Historical moves never gain a preference from policy written by a later engine. */
export function milestoneFocus(board, ports) {
  if (!engineAtLeast(board, FOCUS_MILESTONE_ENGINE)) return null;
  if (typeof ports?.milestones !== 'function') throw new TypeError('milestone focus needs its explicit store reader');
  const setting = lineSettings(board).focusMilestone;
  const name = typeof setting === 'string' ? setting : setting?.name;
  if (typeof name !== 'string') return null;
  const ids = new Set([...(ports.milestones(board).find(milestone => milestone.name === name)?.items ?? []), ...mainRedIds(board)]);
  return { name, overflow: setting?.overflow === true, ids };
}

/** Add a leading preference while leaving the caller's established comparison intact within each group. */
export function focusOrder(board, compare, ports) {
  const focus = milestoneFocus(board, ports);
  return focus ? (a, b) => Number(focus.ids.has(b.item_id)) - Number(focus.ids.has(a.item_id)) || compare(a, b) : compare;
}

/** Only a selected outside item earns this note; existing held work is resumed without a new offer. */
export function focusReasons(board, item, reasons = [], ports) {
  const focus = milestoneFocus(board, ports);
  return focus && item && !focus.ids.has(item.item_id)
    ? [...reasons, `no claimable work in focus milestone ${focus.name}; offering outside it`]
    : reasons;
}

/** The default command compares already eligible offers, never bypassing their normal claim or review guards. */
export function focusReviewFirst(board, review, build, ports) {
  const focus = milestoneFocus(board, ports);
  return !focus || focus.ids.has(review.item_id) || !build || !focus.ids.has(build.item_id);
}
