#!/usr/bin/env node
/** The process the dispatcher starts for one admitted submit gate: it drives the gate's job with the drive cell [C7]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(import.meta.url);

/**
 * The arguments the dispatcher starts this process with: the hand-off's request file and the driver id it admitted
 * the gate under.
 *
 * @param {string[]} argv - process.argv.
 * @returns {string[]}
 */
export function gateDriveArguments(argv) {
  return [argv[2], argv[3]];
}

/** This entry's own path, so the dispatcher starts it from a captured tools snapshot. */
export function gateDriveWorkerEntry() { return ENTRY; }

if (process.argv[1] && resolve(process.argv[1]) === ENTRY) {
  const [requestFile, owner] = gateDriveArguments(process.argv);
  // The board's module graph reaches the worker through the lib front door; load it once this entry runs.
  Promise.all([import('../apps/lib/src/core/native-board.js'), import('../apps/lib/src/shell/submit-handoff-worker.js')])
    .then(([nativeBoard, worker]) => worker.driveSubmitHandoff(requestFile, { nativeBoard, owner }))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
