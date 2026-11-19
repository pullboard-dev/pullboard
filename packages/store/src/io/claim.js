import { rejectionReturnEnabled } from '../logic/rework.js';
import { listItems } from './board/query.js';
import { awaitingGateOrReview } from './submit/handoff/records.js';

/**
 * Read the live claim shared by interactive and automatic work selection.
 * A child counts unless this seat also holds its parent: next hands a held slice of an unheld item back rather than claim another (#10846).
 */
export function heldClaim(board, agentId, { items = listItems(board) } = {}) {
  const owned = items.filter(item => item.item_status === 'claimed' && item.item_owner === agentId);
  const parents = new Set(owned.map(item => item.item_id));
  const claims = owned.filter(item => (item.item_parent_id === null || !parents.has(item.item_parent_id)) && !awaitingGateOrReview(board, item));
  return (rejectionReturnEnabled(board)
    ? claims.find(item => item.item_verdict === 'REJECT' && item.item_built_by === agentId)
    : null) ?? claims[0] ?? null;
}
