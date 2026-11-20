/** A child item that goes back to open holds the parent items that wait on it [XB1,#11045]. */
import { foreignDependencies } from '../../../../../items/index.js';
import { holdItem } from '../hold/item.js';
import { logEvent } from '../event/log.js';

/** The board's own acting identity for a hold it places itself; the same name the hold move accepts. */
const COORDINATOR = 'coordinator';

/** A received state in these means the item was done on its own board. */
const DONE = new Set(['verified', 'landed']);

/**
 * The ids of the child items whose state went from verified or landed back to open between two received announcements.
 * Why: nothing else compares the old and new state; a prerequisite that reopens must not leave its dependents building on it.
 *
 * @param {{ rows?: { id: number, state: string }[] } | null} previous - The last state stored for this link generation, or null.
 * @param {{ rows: { id: number, state: string }[] }} next - The state just received.
 * @returns {number[]} Sorted ids.
 */
export function regressedIds(previous, next) {
  if (!previous || !Array.isArray(previous.rows)) return [];
  const before = new Map(previous.rows.map(row => [row.id, row.state]));
  return next.rows.filter(row => row.state === 'open' && DONE.has(before.get(row.id))).map(row => row.id).sort((a, b) => a - b);
}

/**
 * Hold each claimed dependent of a regressed child item, reason naming repo#id; a dependent that already landed gets a notice fact and no hold.
 * Why a submitted dependent gets a notice, not a hold: the board's hold move takes open, claimed or verified items only and replays on every device, so a submitted one is reported for the person to rule on.
 *
 * @param {object} board - The receiving (parent) board, inside its transaction.
 * @param {{ handle: string, ids: number[] }} regression - The child's handle as this board writes it and the regressed child item ids.
 * @returns {{ held: number[], noticed: number[] }} Dependent ids held, and dependent ids that got a notice fact.
 */
export function holdRegressedDependents(board, { handle, ids }) {
  const held = [];
  const noticed = [];
  if (ids.length === 0) return { held, noticed };
  const rows = board.db.prepare("SELECT item_id, item_status, item_after, item_merged_commit FROM item WHERE item_status IN ('claimed','submitted','verified') OR item_merged_commit IS NOT NULL ORDER BY item_id").all();
  for (const item of rows) {
    const named = foreignDependencies(item).filter(ref => ref.repo === handle && ids.includes(ref.id));
    for (const ref of named) {
      const label = `${handle}#${ref.id}`;
      if (item.item_merged_commit || item.item_status === 'verified') {
        logEvent(board, COORDINATOR, 'board_link_regress_notice', item.item_id, { dependency: label, note: `${label} went back to open after this item landed` });
        noticed.push(item.item_id);
      } else if (item.item_status === 'claimed') {
        holdItem(board, item.item_id, { agentId: COORDINATOR, reason: `${label} went back to open on its own board; hold until it is verified again` });
        held.push(item.item_id);
      } else {
        logEvent(board, COORDINATOR, 'board_link_regress_notice', item.item_id, { dependency: label, note: `${label} went back to open while this item is in review` });
        noticed.push(item.item_id);
      }
    }
  }
  return { held, noticed };
}
