import { staleInstant, staleStateLimits } from '../../../../src/board-stale-state-policy.js';
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

/** Capture at most 32 already-lapsed idle claims before an ordinary write; incomplete activity stays unknown. */
export function captureLapsedClaims(ctx, board, actor) {
  const at = ctx.clock.now();
  const limit = staleStateLimits(ctx.config).claim;
  const cutoff = new Date(at.getTime() - limit).toISOString();
  const previous = Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lapsed_claim_scan_cursor'").get()?.meta_value ?? 0);
  const cursor = Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  const items = board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND item_lease_until<=? AND item_id>? ORDER BY item_id LIMIT 32").all(actor, cutoff, cursor);
  if (items.length < 32) items.push(...board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND item_lease_until<=? AND item_id<=? ORDER BY item_id LIMIT ?").all(actor, cutoff, cursor, 32 - items.length));
  if (!items.length) return null;
  const snapshot = staleStateSnapshot(board, ctx.config, { now: at, items, claimsOnly: true, blocker: () => false,
    workObservation: holder => observeStaleWork(board, holder) });
  snapshot.claimScan = { previous: cursor, next: items.at(-1).item_id };
  snapshot.claims = snapshot.claims.filter(row => row.evidence.complete && row.expired && staleInstant(row.leaseUntil, at.getTime()) !== null
    && Number.isSafeInteger(row.leaseMs) && row.leaseMs > 0);
  return snapshot;
}
