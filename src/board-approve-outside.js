import { approveOutside as applyOutsideApproval } from './outside-store.js';
import { atomic } from './board-event-log.js';

/** Record the person's exact-commit owner approval. */
export function approveOutside(board, id, options) { return applyOutsideApproval(board, id, options, atomic); }
