/** The pullboard sentinel command, in its own module so an item adding another command never edits these lines. */
import { parseProcessCensus } from '../../packages/kernel/src/core/process-census.js';
import {
  sentinelCommand,
} from '../sentinel-command.js';
import {
  main,
  ordered,
  whoAmI,
  withBoard,
} from '../cli.js';
import { personCommandContext } from '../cli-context.js';
import { recordTimeCheckpoint } from '../stats-time-checkpoint.js';

/** Run `pullboard sentinel` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const ctx = personCommandContext(io, { main, ordered });
  const result = await sentinelCommand({ ctx, words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered, parseProcessCensus });
  if (first === 'run' && second === undefined && ctx.info.isMain) {
    withBoard(ctx, board => { if (whoAmI(ctx, board).id === 'coordinator') recordTimeCheckpoint(ctx, board, { reason: 'weekly' }); });
  }
  return result;
}
