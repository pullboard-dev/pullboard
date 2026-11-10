import { heartbeatCommand } from '../presence.js';
/** Agent session hooks observe activity without adding any shared board move [B3]. */
import { context } from '../read.js';
import { withBoardRead } from '../board/read.js';
import { seatAt } from '../item/folder/identity.js';

/**
 * An explicit agent hook records local presence only: it reads the board, writes the private sidecar and returns.
 * With --claims it keeps beating the seat while it holds any claim or queued gate and returns once it holds none.
 *
 * Selection and claiming belong to `pullboard next --take`. A liveness ping that also ran next took the board
 * writer for seconds and handed seats work they never asked for [C7,#3001].
 */
export async function run(io, { values = {} } = {}) {
  const ctx = context(io);
  if (values.claims) {
    // The gate cell's keepalive is the one path that beats a seat; the shell loops that read SQLite directly retire (#3784).
    const { keepClaimsAlive } = await import('../../../../../packages/gate/index.js');
    await keepClaimsAlive(ctx.info.root);
  }
  const seat = await withBoardRead(ctx, board => {
    heartbeatCommand(io, { ctx, board });
    return seatAt(board, ctx.info.root);
  });
  io.result?.({ seat: seat?.agent_id ?? null, presence: seat?.presence ?? 'gone', heartbeatAt: seat?.heartbeatAt ?? null });
  return 0;
}
