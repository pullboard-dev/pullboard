/** A running hand-off resumes only while its item is claimed by its seat at its frozen digest [C7,#4073]. */
import { unassignedEngine } from './engine-next.js';
export const RUNNING_HANDOFF_ITEM_CHECK_ENGINE = unassignedEngine();
