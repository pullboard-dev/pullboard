/** Record one seat checkpoint fact at claim, submit, an exit-rule stop or a handoff, only when seat.checkpoints is on [C7,#8535]. */
import { buildCheckpoint } from '../../../../packages/seats/index.js';
import { checkpointText } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

/**
 * Order one note fact holding the five checkpoint parts for this moment; with the setting off it returns at once and writes nothing.
 *
 * Why a refusal only warns: a checkpoint reports on the move that was just made, so a refused fact must never undo or fail that move.
 *
 * @param {any} ctx The command context; its config holds seat.checkpoints.
 * @param {any} board The open board.
 * @param {{ item: number, agent: string, moment: string, parts: Parameters<typeof buildCheckpoint>[0] }} checkpoint
 * @param {(ctx: any, board: any, operation: string, args: any[]) => Promise<any>} order The caller's ordered-move function.
 * @returns {Promise<boolean>} True when a fact was recorded.
 */
export async function recordCheckpoint(ctx, board, { item, agent, moment, parts }, order) {
  if (ctx.config.seat?.checkpoints !== true) return false;
  try {
    await order(ctx, board, 'appendFact', [item, { agentId: agent, kind: 'note', text: checkpointText(moment, buildCheckpoint(parts)) }]);
    return true;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    ctx.io.err?.(`checkpoint at ${moment} not recorded: ${error.message}`);
    return false;
  }
}
