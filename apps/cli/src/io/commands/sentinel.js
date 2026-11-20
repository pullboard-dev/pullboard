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
import { trunkRef } from '../../../../../packages/git/light.js';
import { lineTuneEnabled } from '../../../../../packages/config/index.js';
import { landingSelfCheckPorts } from '../landing/sentinel-landing.js';

/** Run `pullboard sentinel` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const ctx = personCommandContext(io, { main, ordered });
  const result = await sentinelCommand({ ctx, words: [first, second, ...rest].filter(value => value !== undefined), values, withBoard, whoAmI, ordered, parseProcessCensus,
    // The comparison cache and landing batches the health cell's landing self-check reads, behind sentinels.landingSelfCheck (#10125).
    landingSelfCheck: landingSelfCheckPorts,
    // The lapsed pass re-sweeps the derived-state table when main moves, reading main from this ref (#3010).
    trunkRef });
  if (first === 'run' && second === undefined && ctx.info.isMain) {
    withBoard(ctx, board => { if (whoAmI(ctx, board).id === 'coordinator') recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events }); });
  }
  if (first === 'run' && second === undefined && !values['health-only'] && !values['lapsed-only'] && lineTuneEnabled()) await runLineTune(io);
  return result;
}

/**
 * Run the line tune apply once for this sentinel pass, so the line tunes on the board cadence with no timer of its own (#1099).
 * Why a captured io: the apply says its own lines and result, and the pass prints one result; its lines join the pass output.
 * Why the catch: a refusal (not the coordinator, a locked board) is reported in the pass output and never fails the pass.
 */
async function runLineTune(io) {
  const lines = [];
  const quiet = Object.create(io);
  quiet.say = line => { lines.push(line); };
  quiet.result = undefined;
  try {
    const { runTuneApply } = await import('./flow.js');
    await runTuneApply(quiet, { values: {} });
  } catch (error) {
    lines.push(`flow tune --apply: refused${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? error}`);
  }
  for (const line of lines) io.say(line);
}
