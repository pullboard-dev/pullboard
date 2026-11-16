/** Health words another cell reads without loading the health cell's doctor, sweeps and map [C7,#7081]. */

/** The pause reason ends with this text; the idle answer lists it before every other reason [#3741]. */
export const REVIEW_COVER_PAUSE_TAIL = 'new builds wait for independent review cover';

/** The claim projection, release blockers and stale-state snapshot a status read prints, without the doctor or sweeps [C7,#8645]. */
export { claimHealthProjection } from './src/io/claim/projection.js';
export { releaseBlockingItems } from './src/logic/stale/state/blockers.js';
export { staleStateSnapshot } from './src/io/stale/state/snapshot.js';
