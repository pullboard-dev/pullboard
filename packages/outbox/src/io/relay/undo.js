/** Queued moves taken back inside the store's own transaction and guard lifting [C7]. */
import { atomic } from '../../../../store/index.js';
import { suspendStoreGuards } from '../../../../store/index.js';
import { undoQueuedWith } from '../../logic/undo.js';

/** Mark this connection as taking moves back, the token the item-status guard lets through [C7]. */
function holdMoving(db) {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS moving (token INTEGER); INSERT INTO temp.moving (token) VALUES (1)');
}

/** Clear the token once every move is back [C7]. */
function releaseMoving(db) {
  db.exec('DELETE FROM temp.moving');
}

/**
 * Take queued moves back on `board`, newest first, in one transaction. Returns null, or, changing nothing, why it could not.
 *
 * @param {any} board
 * @param {{ changes?: string[], sequences?: { name: string, seq: number }[] }[]} entries - Oldest first.
 * @param {((board: any) => void) | undefined} within - Runs in the undo's own transaction.
 * @returns {string | null}
 */
export function undoQueued(board, entries, within) {
  return undoQueuedWith({ atomic, suspendStoreGuards, holdMoving, releaseMoving }, board, entries, within);
}
