/** A quarantined runner is probed and cleared even when no gate is waiting [C7,#8306]. */
import { recoverUnavailableRunners } from '../recovery.js';

/**
 * Build the idle-queue recovery driver from the queue's opener, so this file never reaches into the front door's internals.
 * Why: only a gate's wait loop or lease acquisition started recovery, so a runner quarantined on an empty queue sat dark. The driver
 * runs the wait loop's own pass: a row is probed once its probe_after is due, and a good answer clears it.
 *
 * @param {{ open: (file: string) => import('node:sqlite').DatabaseSync, machineResourceFile: () => string, validatedRunners: (runners: object[]) => object[] }} ports
 * @returns {(runners: object[], probes: object, options?: { now?: number, file?: string }) => Promise<boolean>} Whether any runner returned to service.
 */
export function idleRunnerRecovery({ open, machineResourceFile, validatedRunners }) {
  return async function recoverIdleRunners(runners, probes, { now = Date.now(), file = machineResourceFile() } = {}) {
    const db = open(file);
    try { return await recoverUnavailableRunners(db, validatedRunners(runners), { ...probes, now }); } finally { db.close(); }
  };
}
