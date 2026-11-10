/** The pullboard sentinel command, in its own module so an item adding another command never edits these lines. */
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import {
  sentinelCommand,
} from '../../../../../packages/sentinels/index.js';
import {
  main,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';
import { personCommandContext } from '../context.js';
import { recordTimeCheckpoint } from '../../../../../packages/stats/index.js';
import { retainedReceipts } from '../../../../../packages/gate/index.js';
import { events } from '../../../../../packages/store/index.js';

/** Run `pullboard sentinel` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const ctx = personCommandContext(io, { main, ordered });
  // Only a run scans health; the module that holds the drive detector loads for it alone.
  const stalledGateDrives = first === 'run' ? (await import('../submit/handoff.js')).stalledGateDriveFindings : undefined;
  const result = await sentinelCommand({ ctx, words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered, parseProcessCensus,
    sweepSubmitHandoffs: async () => {
      await import('../submit/handoff.js').then(module => module.sweepDeadSubmitHandoffs(ctx));
      // A landing worker that died mid-batch is replaced by the health sweep, not by a later lucky wake (#2912).
      if (ctx.info?.isMain) {
        try { await (await import('../../../../../packages/landing/index.js')).recoverAutomaticLanding(ctx.info.root, new URL('../landing/automatic.js', import.meta.url)); }
        catch (error) { io.err(`automatic landing recovery unavailable: ${error.code ?? error.name}: ${error.message}`); }
      }
    },
    // A gate drive that renews its lease with no step for 20 minutes is shouted Stuck, naming its item and job (#3661).
    stalledGateDrives });
  if (first === 'run' && second === undefined && ctx.info.isMain) {
    withBoard(ctx, board => { if (whoAmI(ctx, board).id === 'coordinator') recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events }); });
  }
  return result;
}
