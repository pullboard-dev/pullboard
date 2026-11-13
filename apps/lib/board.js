/** The board composition root's open and close, narrower than the front door, which also exports the CLI's main [C7]. */
import { closeBoard as closeNativeBoard } from './src/logic/native.js';
import { openBoard as openNativeBoard } from './src/logic/native.js';

/**
 * Open a board file through the native composition root.
 *
 * Why: a cell fixture needs the composed board without the library front door and without a deep import past the index.
 *
 * @param {string} file - The board.sqlite path, or ':memory:'.
 * @param {{ now: () => Date }} [clock] - The board clock; the native clock when omitted.
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function openBoard(file, clock, options) { return openNativeBoard(file, clock, options); }

/** Close a board opened by openBoard. */
export function closeBoard(board) { return closeNativeBoard(board); }
