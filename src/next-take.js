/** Current-seat dispatch shares board eligibility with the heartbeat warning [N2,V1,B3]. */
import * as store from './board.js';
import { dispatchWork } from './dispatch-eligibility.js';
import {
  nextReview,
  ownSessionReviews,
} from './next-review.js';
import { headCommit } from './git.js';
import { trunkMerge } from './trusted-policy.js';
import { Refused } from './refused.js';
import {
  MainSpecMerged,
  checkMainVerifier,
  claimFreezer,
  claimOrdered,
  idArg,
  ordered,
  whoAmI,
  withBoard,
  withBoardRead,
} from './cli.js';

/** Resolve current-seat eligibility on either a read snapshot or the final ordered writer. */
function selected(ctx, board, values) {
  checkMainVerifier(ctx, board, values);
  const me = whoAmI(ctx, board);
  return dispatchWork(board, store.agentById(board, me.id), {
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board),
  });
}

/** Take one eligible review or build through existing ordered guards, without routing to another seat. */
export async function nextTake(ctx, values = {}) {
  const looked = withBoardRead(ctx, board => selected(ctx, board, values));
  if (!looked.item || looked.held && !looked.review) return looked;
  return await withBoard(ctx, async board => {
    const picked = selected(ctx, board, values);
    const me = whoAmI(ctx, board);
    if (picked.held && !picked.review || !picked.item) return picked;
    if (picked.review) {
      const reviewed = await nextReview(ctx, board, me, values, {
        ordered: (operation, args) => ordered(ctx, board, operation, args), idArg, trunkMerge,
      });
      // Conflict preflight may have returned the selected review; re-read eligibility before building.
      return reviewed.item ? { ...reviewed, review: true } : { ...reviewed, retry: true };
    }
    try {
      await claimOrdered(ctx, board, [picked.item.item_id, {
        agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root),
      }]);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: picked.item.item_id, rows: error.rows } };
      // A peer taking the selected item is a normal queue race; a held-seat refusal stays actionable.
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true };
      throw error;
    }
    return { ...picked, item: store.getItem(board, picked.item.item_id), review: false };
  });
}
