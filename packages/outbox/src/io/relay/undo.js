/** Queued moves taken back inside the store's own transaction and guard lifting [C7]. */
import { atomic } from '../../../../store/index.js';
import { suspendStoreGuards } from '../../../../store/index.js';
import { undoQueuedWith } from '../../logic/undo.js';

/**
 * Take queued moves back on `board`, newest first, in one transaction. Returns null, or, changing nothing, why it could not.
 *
 * @param {any} board
 * @param {{ changes?: string[], sequences?: { name: string, seq: number }[] }[]} entries - Oldest first.
 * @param {((board: any) => void) | undefined} within - Runs in the undo's own transaction.
 * @returns {string | null}
 */
export function undoQueued(board, entries, within) {
  return undoQueuedWith({ atomic, suspendStoreGuards }, board, entries, within);
}
