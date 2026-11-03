/** Place new items only in a release that still holds unlanded work, never in an unshipped release of landed items. */
import { unassignedEngine } from './engine-next.js';
export const LIVE_RELEASE_PLACEMENT_ENGINE = unassignedEngine();
