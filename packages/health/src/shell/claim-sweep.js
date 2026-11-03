/** Background claim maintenance: the Git observations no board command makes for another seat [B4,N2]. */
import { captureLapsedClaims } from './stale-state-capture.js';
import { recordClaimWorktrees } from '../../../activity/index.js';
import { listItems } from '../../../store/index.js';
import { listAgents } from '../../../store/index.js';

/**
 * Record every claimed worktree's changed files, then apply the idle, stalled and returned-claim checks that read
 * those worktrees. Why here: the person's rule (#2427) is that a board command does only its own job, so this runs
 * from `sentinel run` and `maintenance`, never on claim, release or next.
 */
export async function sweepClaims(ctx, board, actor, ordered) {
  recordClaimWorktrees(board, listItems(board), listAgents(board), { now: ctx.clock.now() });
  const snapshot = captureLapsedClaims(ctx, board, actor);
  if (!snapshot) return null;
  const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
  try { await ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }]); }
  catch (error) {
    // A board that moved while this pass looked is observed again on the next pass.
    if (error.code !== 'STALE_STATE_CHANGED') throw error;
  }
  return snapshot;
}
