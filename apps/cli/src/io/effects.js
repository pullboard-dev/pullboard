/** Keep post-recording observations outside the bounded CLI dispatcher [B3,H16]. */
import { heartbeatCommand } from './presence.js';
import { statsRecordCoordinatorUsage } from '../../../../packages/config/index.js';
import { checkpointAfterMove } from '../../../../packages/stats/index.js';
import { usageCheckpointWorkerEntrypoint } from './checkpoint.js';
import { isSubmitHandoffWorker } from '../../../../packages/sandbox/index.js';
import { startClaimBeater } from './beater.js';

/** The moves that leave this seat holding a claim it will work outside the CLI. */
const CLAIMING = new Set(['claim', 'takeHandoff']);

/**
 * Preserve heartbeat order after the original native move succeeds and mark its usage checkpoint due; a merge or
 * withdrawal closes the holders' usage. A recorded claim starts the seat's detached beater, bound to the agent
 * session; a background submit worker has no session.
 */
export async function afterOrderedMove(ctx, board, { requested, operation, args, actor, ordered }) {
  if (requested && ctx.io.recordedMove) heartbeatCommand(ctx.io, { ctx, board, overlaps: ctx.io.defaultLoop !== true });
  if (requested && ctx.io.recordedMove && CLAIMING.has(operation) && !isSubmitHandoffWorker(ctx)) startClaimBeater(ctx.info.root, { seat: actor, board: ctx.file });
  if (['claim', 'submit', 'release', 'merged', 'withdraw'].includes(operation) && actor) {
    await checkpointAfterMove(ctx, board, { agent: actor, item: args[0], operation }, { ordered, worker: usageCheckpointWorkerEntrypoint(), recordCoordinatorUsage: statsRecordCoordinatorUsage() });
  }
}
