/** A seat returned rejections become one echo line each, filled from the board verdict rows [C7,#2220]. */
import { rejectionEchoLine } from '../../../../../packages/items/index.js';
import { returnedRejections } from '../../../../../packages/items/index.js';

/**
 * One echo line per open item this seat built that carries a REJECT verdict, in item order.
 * Why: a builder whose work was sent back reads the reason at once; verdictFor is injected so this reads no board [C7,#2220].
 * @param {object[]} items Board item rows.
 * @param {(id: number) => { verdict_reason?: string, verdict_note?: string } | undefined} verdictFor The latest REJECT verdict row of an item.
 * @param {string} agentId
 * @returns {string[]}
 */
export function returnedEchoLines(items, verdictFor, agentId) {
  return returnedRejections(items, agentId).map(item => {
    const verdict = verdictFor(item.item_id);
    return rejectionEchoLine({ id: item.item_id, title: item.item_title, reason: verdict?.verdict_reason, note: verdict?.verdict_note });
  });
}
