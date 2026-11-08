import { rejectionReturnEnabled } from '../core/rework-family-routing.js';
import { listItems } from './board-query.js';
import { awaitingGateOrReview } from './submit-handoff-read.js';

/** Read the live claim shared by interactive and automatic work selection. */
export function heldClaim(board, agentId, { items = listItems(board) } = {}) {
  const claims = items.filter(item => item.item_status === 'claimed' && item.item_owner === agentId
    && item.item_parent_id === null && !awaitingGateOrReview(board, item));
  return (rejectionReturnEnabled(board)
    ? claims.find(item => item.item_verdict === 'REJECT' && item.item_built_by === agentId)
    : null) ?? claims[0] ?? null;
}
