/** Run the drive cell's fallback reclaim pass for a board command before it answers (RFC 0008 DJ15) [C7]. */
import { lapsedGateJobs } from '../../../../packages/drive/index.js';
import { reclaimPass } from '../../../../packages/drive/index.js';
import { withBoardRead } from './cli-board-read.js';
import { writeFallback } from './cli-board-read.js';

/**
 * Look for lapsed gate jobs on a read handle and, only when one exists, open the board for writing and drive at
 * most one of them by one transition. Returns the pass's outcome, or null when nothing was lapsed or the pass
 * could not run.
 *
 * Why: the dispatcher reclaims first, and this is the fallback, so it must never fail or slow the command it rides
 * on: a healthy board costs one read, and any error leaves the command's own answer untouched.
 *
 * @param {any} ctx - The command's context.
 * @param {string} command - The command running the pass, named in the driver id.
 * @returns {Promise<Awaited<ReturnType<typeof reclaimPass>> | null>}
 */
export async function fallbackReclaim(ctx, command) {
  const now = () => ctx.clock.now().getTime();
  try {
    const lapsed = await withBoardRead(ctx, board => lapsedGateJobs(board.db, { now: now() }).length);
    if (!lapsed) return null;
    return await writeFallback(ctx, board => reclaimPass(board.db, { owner: `fallback:${command}:${process.pid}`, repo: ctx.info.root, now }));
  } catch {
    return null;
  }
}
