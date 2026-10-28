/** Named milestone preference reads only recorded board policy and preserves each group's existing order [N2,B16,H16]. */
import { ENGINE_VERSION } from './machine.js';
import { FOCUS_MILESTONE_ENGINE } from './focus-milestone-engine.js';
import { lineSettings } from '../packages/state/src/core/line-settings-read.js';

/** Historical moves never gain a preference from policy written by a later engine. */
export function milestoneFocus(board, ports) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < FOCUS_MILESTONE_ENGINE) return null;
  if (typeof ports?.milestones !== 'function') throw new TypeError('milestone focus needs its explicit store reader');
  const name = lineSettings(board).focusMilestone;
  if (typeof name !== 'string') return null;
  return { name, ids: new Set(ports.milestones(board).find(milestone => milestone.name === name)?.items ?? []) };
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
