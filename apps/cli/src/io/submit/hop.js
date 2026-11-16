/** The gate hop table the CLI hands the API cell: the moves cell's hop table, run by the API over the jobs cell's own lease rule [C7,#8352,#8353]. */
import { hopEngine } from '../../../../../packages/moves/index.js';
import { runTable } from '../../../../../packages/moves/index.js';
import { hopTableOver } from '../../../../../packages/api/index.js';
import { fencedHopEnabled } from '../../../../../packages/config/index.js';

/**
 * The hop table's answer for a snapshot and a move, at a lease length.
 * Why here: the API cell may not import the moves cell, so the serving app and the submit both provide this one table.
 */
export const gateHopTable = hopTableOver({ hopEngine, runTable });

/** The submit's hop port: the table with gate.fencedHop on, else null so the offer touches no hop row. */
export function submitGateHop() {
  return fencedHopEnabled() ? { table: gateHopTable } : null;
}
