/** Keep post-recording observations outside the bounded CLI dispatcher [B3,H16]. */
import { heartbeatCommand } from './presence.js';
import { checkpointAfterMove } from '../../../../packages/stats/index.js';
import { usageCheckpointWorkerEntrypoint } from './checkpoint.js';

/** Preserve heartbeat order after the original native move succeeds and mark its usage checkpoint due; a merge or withdrawal closes the holders' usage. */
export async function afterOrderedMove(ctx, board, { requested, operation, args, actor, ordered }) {
  if (requested && ctx.io.recordedMove) heartbeatCommand(ctx.io, { ctx, board, overlaps: ctx.io.defaultLoop !== true });
  if (['claim', 'submit', 'release', 'merged', 'withdraw'].includes(operation) && actor) {
    await checkpointAfterMove(ctx, board, { agent: actor, item: args[0], operation }, { ordered, worker: usageCheckpointWorkerEntrypoint() });
  }
}
