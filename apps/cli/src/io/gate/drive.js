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
  Promise.all([import('../../../../lib/index.js'), import('../../../index.js')])
    .then(([nativeBoard, worker]) => worker.driveSubmitHandoff(requestFile, { nativeBoard, owner }))
    // Once its result is recorded the driver exits at once: a leaked handle (a socket, a timer) or a stalled run's stage
    // must not keep it holding a handoff slot (#3108, #3661). A stopped driver's own handler frees its lease and exits.
    .then(outcome => { if (!outcome?.stopped) process.exit(process.exitCode ?? 0); },
      error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
