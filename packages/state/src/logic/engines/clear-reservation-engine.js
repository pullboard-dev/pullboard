import { unassignedEngine } from './engine-next.js';
/** The board may clear an item reservation that reserveItem recorded; older replays never see the clear [C7]. */
export const CLEAR_RESERVATION_ENGINE = unassignedEngine();
