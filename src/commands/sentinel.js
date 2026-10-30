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

/** Run `pullboard sentinel` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  return await sentinelCommand({ ctx: personCommandContext(io, { main, ordered }), words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered, parseProcessCensus });
}
