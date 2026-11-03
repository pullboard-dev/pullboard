/** The detached process that runs due usage checkpoints so no board command waits on usage accounting [N2,B3]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Expose the real worker module as a declared import dependency of its launcher. */
export function usageCheckpointWorkerEntrypoint() { return fileURLToPath(import.meta.url); }

/**
 * Drain every due checkpoint of one repository, each as the seat whose checkout queued it.
 * Why: each runs with the move's own time, last event and session environment, so totals match the in-line checkpoint.
 */
export async function runUsageCheckpointWorker(commonDir) {
  const nativeBoard = await import('../core/native-board.js');
  const { cliContext$context: context, cliContext$withBoard: withBoard } = await import('../../../cli/index.js');
  const { cliClaim$ordered: ordered } = await import('../../../cli/index.js');
  const { drainUsageCheckpoints, publishUsage } = await import('../../../../packages/stats/index.js');
  await drainUsageCheckpoints(commonDir, async (request) => {
    const ctx = context({ cwd: request.root, nativeBoard, say() {}, err() {} });
    await withBoard(ctx, board => publishUsage(ctx, board, { agent: request.agent, item: request.item, operation: request.operation },
      { ordered, now: request.now, lastEventId: request.lastEventId, environment: request.environment }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUsageCheckpointWorker(process.argv[2]).catch(() => { process.exitCode = 1; });
}
