/** Health words another cell reads without loading the health cell's doctor, sweeps and map [C7,#7081]. */

/** The pause reason ends with this text; the idle answer lists it before every other reason [#3741]. */
export const REVIEW_COVER_PAUSE_TAIL = 'new builds wait for independent review cover';


/** The clock table: owner, deadline and default move for every non-terminal item state [B4,C7]. */
export { CLOCK_TABLE, CLOCK_TERMINAL, clockRow, clockDue } from './src/logic/clock/table.js';
/** Read the derived board state without loading the health cell's full index. */
export { readDerivedState } from './src/io/derived.js';
