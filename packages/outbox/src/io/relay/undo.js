/** Queued moves taken back inside the store's own transaction and guard lifting [C7]. */
import { atomic } from '../../../../store/index.js';
import { suspendStoreGuards } from '../../../../store/index.js';
import { undoQueuedWith } from '../../logic/undo.js';

/**
 * Take queued moves back on `board`, newest first, in one transaction. Returns null, or, changing nothing, why it could not.
 *
 * @param {any} board
 * @param {{ changes?: string[], sequences?: { name: string, seq: number }[] }[]} entries - Oldest first.
 * @returns {string | null}
 */
export function undoQueued(board, entries) {
  return undoQueuedWith({ atomic, suspendStoreGuards }, board, entries);
}
