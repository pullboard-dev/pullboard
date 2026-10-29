/** SSH runner entry point in a pinned capsule with a static trusted resource graph. */
// The front door: each worker step lives in its own module; this file only creates this copy's state and dispatches.
import { createWorkerState } from './runner-worker-state.js';
import { serveHealth } from './runner-worker-health.js';
import { main } from './runner-worker-main.js';
import { failedWorker } from './runner-worker-receipt.js';

// This copy's own handles, timers and flags: a second copy loaded under another URL gets its own.
export const workerState = createWorkerState(import.meta.url);

if (process.argv[2] === '--health') serveHealth(process.argv[3]);
else main(workerState).catch(() => failedWorker(workerState));
