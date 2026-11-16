/** An item's readiness command is native metadata, just like its expected build estimate [C7,H16]. */
import { Refused } from '../../../kernel/index.js';
import { deleteBoardMeta } from './board/meta.js';
import { writeBoardMeta } from './board/meta.js';

/** Longest readiness command the board stores. */
export const READINESS_COMMAND_LIMIT = 500;

/** Require text of at most the limit; an empty string clears the command. */
export function validateReadinessCommand(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > READINESS_COMMAND_LIMIT) {
    throw new Refused('BAD_READINESS', `a readiness command is text of at most ${READINESS_COMMAND_LIMIT} characters; use --readiness "<command>" or "" to clear it`);
  }
}

/** Persist only an explicitly authored command; an empty one removes it so the item reads empty again. */
export function saveReadinessCommand(board, id, value) {
  if (value === undefined) return;
  const key = `item_readiness_command:${id}`;
  const text = value.trim();
  if (text === '') deleteBoardMeta(board.db, key);
  else writeBoardMeta(board.db, key, JSON.stringify(text));
}
