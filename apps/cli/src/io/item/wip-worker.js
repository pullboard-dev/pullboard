/** The background worker a board call starts to snapshot a claimed item folder after the command has exited [C7,#12746]. */
import { fileURLToPath } from 'node:url';
import { snapshotWip } from './wip.js';

/** The script a board call launches. */
export const WIP_WORKER = fileURLToPath(import.meta.url);

if (process.argv[1] === WIP_WORKER) {
  try { snapshotWip(process.argv[2], process.argv[3]); } catch { process.exitCode = 1; }
}
