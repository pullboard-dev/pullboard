/** Shared read-only claim health for status and complete native board reads [B4,C7]. */
import { staleStateSnapshot } from '../stale/state/snapshot.js';
import { releaseBlockingItems } from '../../logic/stale/state/blockers.js';

/** Project the same stale-state observation without turning absent work evidence into idle time. */
export function claimHealthProjection(snapshot) {
  return new Map(snapshot.claims.map(row => [row.id, {
    state: row.health,
    idleMinutes: Number.isFinite(row.idleMs) ? Math.floor(row.idleMs / 60_000) : null,
    waitingOn: row.waitingOn ?? [],
    handoffRef: row.handoff?.pin ?? null,
  }]));
}

/** Capture claim health using status's release blockers, seat evidence and observation time; `options.workObservation` supplies actual work evidence. */
export function claimHealthSnapshot(board, config, now = board.clock.now(), options = {}) {
  const blockers = releaseBlockingItems(board);
  return claimHealthProjection(staleStateSnapshot(board, config, {
    ...options, now, blocker: item => blockers.has(item.item_id) ? true : null,
  }));
}
