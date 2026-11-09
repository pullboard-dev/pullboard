/** Board commands nudge only already-captured machine launches, never create a submission [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../../packages/kernel/core.js';

/** The dispatcher entry whose recover mode runs the full check detached. */
const DISPATCHER_ENTRY = fileURLToPath(new URL('../../../../../bin/handoff-worker-dispatcher.js', import.meta.url));

/**
 * Wake recovery of queued dispatch without waiting on it; help, non-board repos, empty queues and a dispatcher whose
 * heartbeat is fresh stay inert. Why: the full check (listing the machine's lock holders, probing their processes)
 * ran on every command's critical path and cost 4-13 s at load 32-50, which pushed `next` past NEXT_TIMEOUT. Now a
 * one-stat heartbeat check decides, and only a stale one starts the full check as a detached process [C7].
 *
 * @param {{ cwd: string, err: (line: string) => void }} io
 * @param {{ repoInfo: (cwd: string) => { commonDir: string } }} git
 * @param {{ claim?: () => boolean, start?: (entry: string, options: object) => unknown }} [ports] - Tests pass stand-ins.
 * @returns {Promise<void>}
 */
export async function recoverQueuedHandoffs(io, { repoInfo }, ports = {}) {
  let info;
  try { info = repoInfo(io.cwd); }
  catch (error) {
    if (error instanceof Refused && ['NOT_A_REPO', 'NO_REPO', 'CORE_BARE'].includes(error.code)) return;
    throw error;
  }
  if (!existsSync(join(info.commonDir, 'pullboard', 'board.sqlite'))) return;
  try {
    const claim = ports.claim ?? (await import('../../../../../packages/resources/index.js')).claimHandoffDispatcherWake;
    if (!claim()) return;
  } catch (error) {
    io.err(`queued handoff dispatcher wake unavailable: ${error.code ?? error.name}: ${error.message}`);
    return;
  }
  const start = ports.start ?? (await import('../../../../../packages/drive/index.js')).startDetachedCheck;
  start(DISPATCHER_ENTRY, { args: ['--recover'], cwd: info.commonDir });
}
