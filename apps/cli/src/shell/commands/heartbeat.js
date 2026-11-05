import { heartbeatCommand } from '../cli-presence.js';
/** Agent session hooks observe activity without adding any shared board move [B3]. */
import { context } from '../cli-read-context.js';
import { withBoardRead } from '../cli-board-read.js';
import { seatAt } from '../item-folder-identity.js';

/**
 * An explicit agent hook records local presence only: it reads the board, writes the private sidecar and returns.
 *
 * Selection and claiming belong to `pullboard next --take`. A liveness ping that also ran next took the board
 * writer for seconds and handed seats work they never asked for [C7,#3001].
 */
export async function run(io) {
  const ctx = context(io);
  const seat = await withBoardRead(ctx, board => {
    heartbeatCommand(io, { ctx, board });
    return seatAt(board, ctx.info.root);
  });
  io.result?.({ seat: seat?.agent_id ?? null, presence: seat?.presence ?? 'gone', heartbeatAt: seat?.heartbeatAt ?? null });
  return 0;
}
