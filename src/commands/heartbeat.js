import { nextTake } from '../next-take.js';
import { heartbeatCommand } from '../cli-presence.js';
/** Agent session hooks observe activity without adding any shared board move [B3]. */
import { context } from '../cli-read-context.js';
import { withBoardRead } from '../cli-board-read.js';
import { agentAt } from '../board-query.js';

/** An explicit agent hook records local activity without turning ordinary reads into writers. */
export async function run(io) {
  const ctx = context(io);
  const seat = await withBoardRead(ctx, board => {
    heartbeatCommand(io, { ctx, board });
    return agentAt(board, ctx.info.root);
  });
  let work;
  if (seat && !ctx.info.isMain) {
    const found = await nextTake(ctx);
    if (found.item) work = { item: found.item.item_id, review: found.review, held: found.held };
  }
  io.result?.({ ...(work ? { work } : {}), seat: seat?.agent_id ?? null, presence: seat?.presence ?? 'gone', heartbeatAt: seat?.heartbeatAt ?? null });
  return 0;
}
