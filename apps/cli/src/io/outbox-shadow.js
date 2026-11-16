/** Hand the relay outbox writer the outbox table when moves.shadow is on, so its queue and park compares are recorded [C7,#8389]. */
import { movesShadowEnabled } from '../../../../packages/config/index.js';

/**
 * Provide the outbox table to the outbox cell's front door when this machine opted in to shadow compares, and return the door.
 * Why here: the outbox cell sits below moves, so the app that sees both composes them; with the setting off the moves cell is never loaded.
 *
 * @template T
 * @param {T & { provideOutboxTable: Function }} outbox - The outbox cell's front door, which the caller already loads.
 * @returns {Promise<T>}
 */
export async function withOutboxShadow(outbox) {
  if (movesShadowEnabled()) {
    const { OUTBOX_TABLE, OUTBOX_RULES, runTable } = await import('../../../../packages/moves/index.js');
    outbox.provideOutboxTable((snapshot, move) => runTable(OUTBOX_TABLE, OUTBOX_RULES, snapshot, move), movesShadowEnabled);
  } else outbox.provideOutboxTable(null);
  return outbox;
}
