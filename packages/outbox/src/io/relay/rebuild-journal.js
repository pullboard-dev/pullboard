/**
 * The outbox rebuild's journal, kept on the board itself (#6728). A rebuild takes the queued moves back, applies what
 * the relay ordered, then makes the unsent tail again; the outbox file is rewritten only at the end, so a stop between
 * steps once left a board the old outbox could not be taken back from. Each step that changes the board now leaves its
 * record in the same transaction, so a restart can tell which steps are done and finish the rest.
 */

import {
  deleteBoardMeta,
  deleteBoardMetaWithPrefix,
  readBoardMeta,
  writeBoardMeta,
} from '../../../../store/index.js';

/** The marker a rebuild leaves once the queued moves are back: its base and the move ids it took back. */
const MARK = 'relay_outbox_rebuild';
/** One re-made move's recorded rows, keyed by its id. */
const REMADE = 'relay_remade_';

/**
 * The rebuild marker, or null when no rebuild is part way.
 *
 * @param {any} board
 * @returns {{ from: number, ids: string[] } | null}
 */
export function readRebuildMark(board) {
  const value = readBoardMeta(board.db, MARK);
  return value ? JSON.parse(value) : null;
}

/**
 * Write the marker; called inside the undo's own transaction so the take-back and its marker commit together.
 *
 * @param {any} board
 * @param {{ baseSequence: number, moves: { move: { id: string } }[] }} outbox
 */
export function markRebuild(board, outbox) {
  clearRebuild(board);
  writeBoardMeta(board.db, MARK, JSON.stringify({ from: outbox.baseSequence, ids: outbox.moves.map((entry) => entry.move.id) }));
}

/**
 * Hooks for `captureBoardChanges` that record a re-made move's rows in the move's own transaction.
 *
 * @param {string} id the move's id
 * @param {{ sequences: { name: string, seq: number }[] }} entry
 * @param {{ result: any }} made the move's result, set inside its transaction before it commits
 * @returns {{ onPrepared: (changeset: Uint8Array, db: any) => void }}
 */
export function remadeJournal(id, entry, made) {
  const changes = [];
  return {
    onPrepared(changeset, db) {
      changes.push(Buffer.from(changeset).toString('base64'));
      writeBoardMeta(db, REMADE + id, JSON.stringify({ changes, sequences: entry.sequences, result: made.result ?? null }));
    },
  };
}

/**
 * The rows a re-made move recorded before a stop, or null when it was not made again.
 *
 * @param {any} board
 * @param {string} id
 * @returns {{ changes: string[], sequences: { name: string, seq: number }[], result: any } | null}
 */
export function readRemade(board, id) {
  const value = readBoardMeta(board.db, REMADE + id);
  return value ? JSON.parse(value) : null;
}

/** Drop the marker and every re-made record: the new outbox is written and holds them now. */
export function clearRebuild(board) {
  deleteBoardMeta(board.db, MARK);
  deleteBoardMetaWithPrefix(board.db, REMADE);
}

/** What runs after each rebuild step, when something is watching; a stop is a throw from it. */
let watcher = null;

/**
 * Watch the rebuild's steps (undo, apply, settle, reapply, write); the watcher may throw to stop the rebuild there.
 * Why: a stop at every step is the one way to prove each resumes, and the steps are local, so no network failure reaches them.
 *
 * @param {((step: string) => void) | null} next the watcher, or null to stop watching
 */
export function watchRebuild(next) { watcher = next; }

/** Tell the watcher one step is done. */
export function rebuildStep(step) { watcher?.(step); }
