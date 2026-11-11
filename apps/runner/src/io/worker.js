/** SSH runner body in a pinned capsule with a static trusted resource graph; importing it starts nothing. */
import { createWorkerState } from './worker/context.js';
import { serveHealth } from './worker/health.js';
import { serveRestart } from './worker/health.js';
import { main } from './worker/entry.js';
import { failedWorker } from './worker/receipt.js';

// Handles, timers and flags of this copy; a copy under another URL gets its own.
export const workerState = createWorkerState(new URL('./scripts/worker.js', import.meta.url).href);

/** Dispatch a health or restart probe, or run the worker; apps/runner/src/io/scripts/worker.js calls it. */
export function runnerWorker(argv) {
  if (argv[2] === '--health') serveHealth(argv[3]);
  else if (argv[2] === '--restart') serveRestart(argv[3]);
  else main(workerState).catch(error => failedWorker(workerState, error));
}
