/** The check-mask probe both baseline check files share [C7,V4]. */
import { closeBoard } from '../../../../packages/store/index.js';
import { validateItemAddition } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';

/** Return the refusal code a check gets from the same validator add and edit use, or null when it passes [C7,V4]. */
export function maskRefusal(check) {
  const board = openBoard(':memory:');
  try {
    validateItemAddition(board, { by: 'coordinator', lane: 'core', title: 'Mask probe', criterion: 'the proof passes', route: 'strong', check });
    return null;
  } catch (error) { return error.code; } finally { closeBoard(board); }
}
