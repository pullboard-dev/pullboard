/** Review is neither offered nor reserved while the item's queued gate has no result; the explicit reserve and verdict refuse it [C7,V4]. */
import { unassignedEngine } from './engine-next.js';
export const REVIEW_GATE_RECEIPT_ENGINE = unassignedEngine();
