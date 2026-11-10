/** The activity delivery read bound to the store's activity projection [R2,N26,H16,C7]. */
import { agentActivity } from '../../../../store/index.js';
import { readActivityDeliveryWith } from '../../logic/delivery/read.js';

/**
 * Read a recipient's interrupt obligations without consuming a message or writing an acknowledgement.
 *
 * @param {any} board
 * @param {string} agentId
 * @param {any} [options]
 */
export function readActivityDelivery(board, agentId, options = {}) {
  return readActivityDeliveryWith(agentActivity, board, agentId, options);
}
