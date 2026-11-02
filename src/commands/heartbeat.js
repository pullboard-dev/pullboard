import { claimWorktrees } from '../../packages/activity/index.js';
import { agentSessionDigest } from '../../packages/person/index.js';
import { nextTake } from '../../packages/sandbox/index.js';
import { mainRedReviewItems } from '../../packages/landing/index.js';
import { mainRedReworkItems } from '../../packages/landing/index.js';
import { computedReturnArgs } from '../../packages/landing/index.js';
import {
  MainSpecMerged,
  checkMainVerifier,
  claimFreezer,
  claimOrdered,
  idArg,
  ordered,
  whoAmI,
  withBoard,
  withBoardRead as takeBoardRead,
} from '../cli.js';
import { heartbeatCommand } from '../cli-presence.js';
/** Agent session hooks observe activity without adding any shared board move [B3]. */
import { context } from '../cli-read-context.js';
import { withBoardRead } from '../cli-board-read.js';
import { seatAt } from '../item-folder-identity.js';

/** An explicit agent hook records local activity without turning ordinary reads into writers. */
export async function run(io) {
  const ctx = context(io);
  const seat = await withBoardRead(ctx, board => {
    heartbeatCommand(io, { ctx, board });
    return seatAt(board, ctx.info.root);
  });
  let work;
  if (seat && !ctx.info.isMain) {
    const found = await nextTake(ctx, {}, { MainSpecMerged, checkMainVerifier, claimFreezer, claimOrdered,
      idArg, ordered, whoAmI, withBoard, withBoardRead: takeBoardRead,
      mainRedReviewItems, mainRedReworkItems, computedReturnArgs, agentSessionDigest, claimWorktrees });
    if (found.item) work = { item: found.item.item_id, review: found.review, held: found.held };
  }
  io.result?.({ ...(work ? { work } : {}), seat: seat?.agent_id ?? null, presence: seat?.presence ?? 'gone', heartbeatAt: seat?.heartbeatAt ?? null });
  return 0;
}
