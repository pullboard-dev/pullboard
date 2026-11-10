/** The store's board-read door for light consumers: the few readers a release ranking needs, without the whole store front door [C7]. */
// Kept apart from core.js so its pure readers never reach store shell code. The event log loads first so the store's import cycle
// starts where the front door starts it; entering at board-query leaves PERSON uninitialized (#4142).
import './event/log.js';
export { openBoardReadOnly, boardId, listItems } from './query.js';
export { milestones } from '../../logic/board/milestones.js';
