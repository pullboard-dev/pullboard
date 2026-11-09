/** SSH runner body in a pinned capsule with a static trusted resource graph; importing it starts nothing. */
import { createWorkerState } from './runner-worker-state.js';
import { serveHealth } from './runner-worker-health.js';
import { serveRestart } from './runner-worker-health.js';
import { main } from './runner-worker-main.js';
import { failedWorker } from './runner-worker-receipt.js';

// Handles, timers and flags of this copy; a copy under another URL gets its own.
export const workerState = createWorkerState(new URL('../../../../src/runner-worker.js', import.meta.url).href);

/** Dispatch a health or restart probe, or run the worker; src/runner-worker.js calls it. */
export function runnerWorker(argv) {
  if (argv[2] === '--health') serveHealth(argv[3]);
  else if (argv[2] === '--restart') serveRestart(argv[3]);
  else main(workerState).catch(error => failedWorker(workerState, error));
}
