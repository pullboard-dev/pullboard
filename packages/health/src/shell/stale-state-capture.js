/** Native maintenance captures local inputs once, before sending a replay-independent observation [B4,H16]. */
import { staleStateSnapshot } from '../core/stale-state-query.js';
import { observeStaleWork } from './stale-work-observation.js';
import { releaseBlockingItems } from '../core/stale-state-blockers.js';

/** Capture main-red evidence only on the write maintenance path, retaining fast read-only status. */
export async function captureStaleState(ctx, board) {
  const blockers = releaseBlockingItems(board);
  const { mainRedReworkItems } = await import('../../../../src/main-red.js');
  for (const id of mainRedReworkItems(ctx.info.root, board)) blockers.add(id);
  return staleStateSnapshot(board, ctx.config, { now: ctx.clock.now(), blocker: item => blockers.has(item.item_id),
    workObservation: actor => observeStaleWork(board, actor) });
}
