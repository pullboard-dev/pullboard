import { unassignedEngine } from './engine-next.js';
/** Releases the board makes itself (idle reclaim, lapsed claim, idle or lapsed review, a refused queued gate) carry a closed reason code instead of OTHER; boards below this engine keep OTHER on replay [C7]. */
export const BOARD_RELEASE_CODES_ENGINE = unassignedEngine();
