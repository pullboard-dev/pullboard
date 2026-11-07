/** Board commands nudge only already-captured machine launches, never create a submission [C7]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/core.js';
import { machineHome } from '../../../../../packages/resources/src/shell/machine-home.js';

/**
 * Whether the machine handoff queue holds a captured launch, read from the directory alone.
 * A read command with an empty queue then never loads the resources package and the gate behind it [C7].
 */
function queueHoldsLaunch() {
  try { return readdirSync(join(machineHome(), 'handoff-queue')).some(name => /^\d+-.+\.json$/u.test(name)); }
  // Any other read failure goes to the full recovery, which reports it without failing the command.
  catch (error) { return error.code !== 'ENOENT'; }
}

/** Recover queued dispatch outside the board writer; help, non-board repos and empty queues stay inert. */
export async function recoverQueuedHandoffs(io, { repoInfo }) {
  let info;
  try { info = repoInfo(io.cwd); }
  catch (error) {
    if (error instanceof Refused && ['NOT_A_REPO', 'NO_REPO', 'CORE_BARE'].includes(error.code)) return;
    throw error;
  }
  if (!existsSync(join(info.commonDir, 'pullboard', 'board.sqlite'))) return;
  if (!queueHoldsLaunch()) return;
  try {
    const { recoverHandoffDispatcher } = await import('../../../../../packages/resources/index.js');
    await recoverHandoffDispatcher({
      loadStartOf: async () => (await import('../../../../../packages/gate/index.js')).exactStart,
    });
  } catch (error) {
    io.err(`queued handoff dispatcher wake unavailable: ${error.code ?? error.name}: ${error.message}`);
  }
}
