/** The main-wide test job request `pullboard serve` hands the board API for the tip a sprint landing moved trunk to [V2,M1,#12182]. */

import { loadConfig } from '../../../../../packages/config/index.js';
import { PULLED_JOB_ENV } from '../../../../../packages/gate/index.js';
import { TEST_OUTCOMES_PREFIX } from '../../../../../packages/gate/index.js';
import { TIMING_RUN_ID_ENV } from '../../../../../packages/gate/index.js';
import { FAILURE_DIAGNOSTICS_SOURCE } from '../../../../../packages/kernel/index.js';
import { GATE_NEEDS } from '../submit/pull.js';
import { GATE_RECEIPT } from '../submit/pull.js';
import { gateJobRun } from '../submit/pull.js';
import { testJobData } from './pull.js';
import { testJobEntry } from './pull.js';

/**
 * The test job that runs the project's gate command, its whole suite, at the landed tip, or null when pullboard.json
 * names no gate command. Why the gate command: it is the main-wide run the project already trusts, and the test job's
 * entry prints the receipt line the board reads, so a red on main after a sprint landing names its failing cases.
 * @param {{ root: string, trunk: string }} request - root: the board host's checkout; trunk: the landed tip.
 * @returns {{ needs: string[], request: object } | null}
 */
export function postLandTestRequest({ root, trunk }) {
  const command = loadConfig(root)?.gate;
  if (typeof command !== 'string' || !command.trim()) return null;
  const entry = testJobEntry(GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX, FAILURE_DIAGNOSTICS_SOURCE);
  return { needs: GATE_NEEDS, request: { run: gateJobRun(), input: { main: trunk, entry, data: testJobData({ main: trunk, commit: trunk, command, files: [] }) } } };
}
