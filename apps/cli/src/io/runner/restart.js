/** Any board command can bring back this machine's local runner when a gate job waits with none live [C7,#6556]. */
import { listItems } from '../../../../../packages/store/index.js';
import { withBoardRead } from '../board/read.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { ensureLocalRunner } from './local.js';

/**
 * Restart the local runner when an item's gate job has no live runner, and return the one line saying so, or null.
 *
 * Why: submit starts the local runner once; a reboot or a kill leaves the job in the gate forever, and only a
 * resubmit healed it, which nothing said (#6556). It never throws: the command it rides on keeps its own answer.
 *
 * @param {any} ctx - The command's context.
 * @param {(root: string) => Promise<{ started: boolean, pid: number | null }>} [local] - The starter, for tests.
 * @returns {Promise<string | null>}
 */
export async function restartDeadRunner(ctx, local = ensureLocalRunner) {
  try {
    const waiting = await withBoardRead(ctx, board => listItems(board).filter(item => item.item_gate_runner === 'none').map(item => item.item_id));
    const host = waiting.length ? primaryCheckoutRoot(ctx.info) : null;
    if (!host) return null;
    const runner = await local(host);
    return runner.started ? `restarted this machine's local runner (pid ${runner.pid}) for the gate job of #${waiting.join(', #')}` : null;
  } catch {
    return null;
  }
}
