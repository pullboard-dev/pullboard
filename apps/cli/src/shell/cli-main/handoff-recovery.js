/** Board commands nudge only already-captured machine launches, never create a submission [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/core.js';

/** Recover queued dispatch outside the board writer; help, non-board repos and empty queues stay inert. */
export async function recoverQueuedHandoffs(io, { repoInfo }) {
  let info;
  try { info = repoInfo(io.cwd); }
  catch (error) {
    if (error instanceof Refused && ['NOT_A_REPO', 'NO_REPO', 'CORE_BARE'].includes(error.code)) return;
    throw error;
  }
  if (!existsSync(join(info.commonDir, 'pullboard', 'board.sqlite'))) return;
  try {
    const { recoverHandoffDispatcher } = await import('../../../../../packages/resources/index.js');
    await recoverHandoffDispatcher({
      loadStartOf: async () => (await import('../../../../../packages/gate/index.js')).exactStart,
    });
  } catch (error) {
    io.err(`queued handoff dispatcher wake unavailable: ${error.code ?? error.name}: ${error.message}`);
  }
}
