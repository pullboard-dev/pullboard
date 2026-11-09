/** SSH runner entry body in a pinned capsule with a static trusted resource graph; importing it starts nothing. */
// Each worker step lives in its own module; this file only creates this copy's state and dispatches when the entry calls it.
import { createWorkerState } from './runner-worker-state.js';
import { serveHealth } from './runner-worker-health.js';
import { serveRestart } from './runner-worker-health.js';
import { main } from './runner-worker-main.js';
import { failedWorker } from './runner-worker-receipt.js';

// This copy's own handles, timers and flags: a second copy loaded under another URL gets its own.
// The pinned capsule's process entry stays src/runner-worker.js; its bytes, not this body's, prove the tooling identity.
export const workerState = createWorkerState(new URL('../../../../src/runner-worker.js', import.meta.url).href);

/** Start this copy: serve a health or restart probe, or run the worker; the process entry src/runner-worker.js calls it. */
export function runnerWorker(argv) {
  if (argv[2] === '--health') serveHealth(argv[3]);
  else if (argv[2] === '--restart') serveRestart(argv[3]);
  else main(workerState).catch(error => failedWorker(workerState, error));
}
