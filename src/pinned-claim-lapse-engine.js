/** A claim on a coordinator-pinned item with no real work for 30 minutes lapses to open [C7]. */
import { unassignedEngine } from './engine-next.js';
export const PINNED_CLAIM_LAPSE_ENGINE = unassignedEngine();
