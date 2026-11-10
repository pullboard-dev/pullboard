import { prepareFreeze } from './freeze.js';
import { restoreFreeze } from './freeze.js';

/** Seal the frozen criterion in place of the caller's freeze callback [H3]. */
export function prepareAfter(board, values, context) { prepareFreeze(board, 'refreeze', values, context); }

/** Give the replayed refreeze back a freeze that returns the sealed criterion [H3]. */
export function replayArgs(board, args) { restoreFreeze(args); }
