import { prepareFreeze } from '../freeze.js';
import { restoreFreeze } from '../freeze.js';

/** A correcting edit seals the criterion it freezes; an ordinary edit freezes nothing [H3]. */
export function prepareAfter(board, values, context) {
  if (values[1]?.correction === true) prepareFreeze(board, 'editItem', values, context);
}

/** Give a replayed correcting edit back a freeze that returns the sealed criterion [H3]. */
export function replayArgs(board, args) {
  if (args[1]?.correction === true) restoreFreeze(args);
}
