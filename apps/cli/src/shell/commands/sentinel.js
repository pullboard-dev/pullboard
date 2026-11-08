/** The pullboard sentinel command, in its own module so an item adding another command never edits these lines. */
import { parseProcessCensus } from '../../../../../packages/kernel/src/core/process-census.js';
import {
  sentinelCommand,
} from '../../../../../packages/sentinels/index.js';
import {
  main,
  ordered,
  whoAmI,
  withBoard,
} from '../cli.js';
import { personCommandContext } from '../cli-context.js';
import { recordTimeCheckpoint } from '../../../../../packages/stats/index.js';
import { retainedReceipts } from '../../../../../packages/gate/index.js';
import { events } from '../../../../../packages/store/index.js';

/** Run `pullboard sentinel` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const ctx = personCommandContext(io, { main, ordered });
  // Only a run scans health; the module that holds the drive detector loads for it alone.
  const stalledGateDrives = first === 'run' ? (await import('../submit-handoff.js')).stalledGateDriveFindings : undefined;
  const result = await sentinelCommand({ ctx, words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered, parseProcessCensus,
    sweepSubmitHandoffs: () => import('../submit-handoff.js').then(module => module.sweepDeadSubmitHandoffs(ctx)),
    // A gate drive that renews its lease with no step for 20 minutes is shouted Stuck, naming its item and job (#3661).
    stalledGateDrives });
  if (first === 'run' && second === undefined && ctx.info.isMain) {
    withBoard(ctx, board => { if (whoAmI(ctx, board).id === 'coordinator') recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events }); });
  }
  return result;
}
