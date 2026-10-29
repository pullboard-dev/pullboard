import { applyOutsideIntake } from './outside-store.js';
import { atomic } from './board-event-log.js';
import { moveItem } from './board.js';
import { addItem } from './board-add-item.js';
import { validateItemAddition } from './board-add-item.js';

/** File or refresh an outside source through the ordinary ordered engine. */
export function intakeOutside(board, options) { return applyOutsideIntake(board, options, { atomic, addItem, moveItem, validateItemAddition }); }
