import { requireOutsideOwner } from './outside-source.js';
import { itemById } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { Refused } from './refused.js';
import { coordinatorOnly } from './board.js';
import { setItem } from './board.js';

/**
 * Record the commit a verified item landed as on the main line, e.g. after a squash merge.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, note?: string }} merge
 */
export function merged(board, id, { agentId, commit, note = '' }) {
  coordinatorOnly(agentId, 'records merges');
  atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status !== 'verified') {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    requireOutsideOwner(board, item);
    setItem(board, id, { item_merged_commit: commit });
    logEvent(board, agentId, 'merged', id, { commit, ...(note.trim() ? { note: note.trim() } : {}) });
  });
}
