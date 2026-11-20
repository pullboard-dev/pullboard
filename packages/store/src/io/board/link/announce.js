/** After an item on a linked child board changes state, tell each parent that waits on it, through the file transport [E32,B24,#11039]. */
import { boardId } from '../query.js';
import { deliverBoardState } from './relay.js';
import { waitedOnItems } from './waiting.js';

/**
 * Announce one item's new state to every parent whose open items wait on it; a throwing transport leaves the sealed delivery queued.
 * Why: the child board stores no foreign waits, so the parent's own item rows (#11158) name who to tell, and the queued
 * outbox entry (deliverBoardState) is what resendPendingBoardStates (#11159) sends again when the transport was down.
 *
 * @param {any} board - The child (source) board whose item just changed state.
 * @param {number} itemId - The item that changed.
 * @param {{ links: { record: object, parentItems: object[], authority: object, capability: object, transport: object }[] }} ports - One entry per linked parent; the command side builds them (packages never import apps).
 * @returns {Promise<{ sent: object[], failed: { linkId: string, correlationId: string, error: string }[] }>}
 */
export async function announceItemState(board, itemId, { links }) {
  const sent = [];
  const failed = [];
  const source = boardId(board);
  const item = board.db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(itemId);
  if (!item) return { sent, failed };
  const position = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS n FROM event').get().n;
  for (const { record, parentItems, authority, capability, transport } of links) {
    if (!waitedOnItems(parentItems, record.child.handle).has(itemId)) continue;
    const correlationId = `state-${itemId}-${position}`;
    const context = { linkId: record.linkId, generation: record.generation, sourceBoardId: source, destinationBoardId: record.parent.boardId,
      position, correlationId, rows: [{ board: source, id: itemId, state: item.item_status }] };
    try {
      sent.push(await deliverBoardState(board, context, { authority, capability, transport }));
    } catch (error) {
      failed.push({ linkId: record.linkId, correlationId, error: String(error?.message ?? error) });
    }
  }
  return { sent, failed };
}
