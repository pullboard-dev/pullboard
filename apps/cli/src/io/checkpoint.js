/** The detached process that runs due usage checkpoints with the cli's own bindings [N2,B3,C7]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from './context.js';
import { withBoard } from './context.js';
import { ordered } from './claim.js';

/** Expose the real worker entry as a declared import dependency of its launcher. */
export function usageCheckpointWorkerEntrypoint() { return fileURLToPath(import.meta.url); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  import('../../../lib/index.js')
    .then(({ runUsageCheckpointWorker }) => runUsageCheckpointWorker(process.argv[2], { context, withBoard, ordered }))
    .catch(() => { process.exitCode = 1; });
}
