/** SSH runner entry point in a pinned capsule with a static trusted resource graph. */
// The front door: each worker step lives in its own module; this file only creates this copy's state and dispatches.
import { createWorkerState } from './runner-worker-state.js';
import { serveHealth } from './runner-worker-health.js';
import { serveRestart } from './runner-worker-health.js';
import { main } from './runner-worker-main.js';
import { failedWorker } from './runner-worker-receipt.js';

// This copy's own handles, timers and flags: a second copy loaded under another URL gets its own.
// The pinned capsule's process entry stays src/runner-worker.js; its bytes, not this body's, prove the tooling identity.
export const workerState = createWorkerState(new URL('../../../../src/runner-worker.js', import.meta.url).href);

if (process.argv[2] === '--health') serveHealth(process.argv[3]);
else if (process.argv[2] === '--restart') serveRestart(process.argv[3]);
else main(workerState).catch(() => failedWorker(workerState));
