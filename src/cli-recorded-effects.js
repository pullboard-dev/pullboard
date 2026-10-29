/** Keep post-recording observations outside the bounded CLI dispatcher [B3,H16]. */
import { heartbeatCommand } from './cli-presence.js';
import { checkpointAfterMove } from './cost-checkpoint.js';

/** Preserve heartbeat and usage order after the original native move succeeds. */
export async function afterOrderedMove(ctx, board, { requested, operation, args, actor }) {
  if (requested && ctx.io.recordedMove) heartbeatCommand(ctx.io, { ctx, board });
  if (['claim', 'submit', 'release'].includes(operation) && actor) {
    await checkpointAfterMove(ctx, board, { agent: actor, item: args[0], operation });
  }
}
