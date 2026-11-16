/** Hand the relay outbox writer the outbox table when moves.shadow or moves.live.outbox is on, so its queue and park compares are recorded or followed [C7,#8389,#8391]. */
import { movesShadowEnabled } from '../../../../packages/config/index.js';
import { movesLiveEnabled } from '../../../../packages/config/index.js';

/** Whether this machine opted in to following the outbox table. */
const outboxLiveEnabled = () => movesLiveEnabled('outbox');

/**
 * Provide the outbox table to the outbox cell's front door when this machine opted in to shadow compares or a live outbox, and return the door.
 * Why here: the outbox cell sits below moves, so the app that sees both composes them; with both settings off the moves cell is never loaded.
 *
 * @template T
 * @param {T & { provideOutboxTable: Function }} outbox - The outbox cell's front door, which the caller already loads.
 * @returns {Promise<T>}
 */
export async function withOutboxShadow(outbox) {
  if (movesShadowEnabled() || outboxLiveEnabled()) {
    const { OUTBOX_TABLE, OUTBOX_RULES, runTable } = await import('../../../../packages/moves/index.js');
    outbox.provideOutboxTable((snapshot, move) => runTable(OUTBOX_TABLE, OUTBOX_RULES, snapshot, move), movesShadowEnabled, outboxLiveEnabled);
  } else outbox.provideOutboxTable(null);
  return outbox;
}
