/** The stale-state snapshot bound to the store's seat heartbeat projection [B4,C7]. */
import { withSeatPresence } from '../../../../../store/index.js';
import { staleStateSnapshotWith } from '../../../logic/stale/state/query.js';

/**
 * Read only current state and indexed activity; callbacks supply actual work without importing Git on fast status.
 *
 * @param {any} board
 * @param {any} [config]
 * @param {any} [options]
 */
export function staleStateSnapshot(board, config = {}, options = {}) {
  return staleStateSnapshotWith(withSeatPresence, board, config, options);
}
