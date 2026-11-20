/** The pullboard sentinel command, in its own module so an item adding another command never edits these lines. */
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import {
  sentinelCommand,
} from '../../../../../packages/sentinels/index.js';
import {
  barActorForCommand,
  launchBaseline,
  main,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';
import { personCommandContext } from '../context.js';
import { recordTimeCheckpoint } from '../../../../../packages/stats/index.js';
import { retainedReceipts } from '../../../../../packages/gate/index.js';
import { events } from '../../../../../packages/store/index.js';
import { remeasureCandidates } from '../../../../../packages/store/index.js';
import { trunkRef } from '../../../../../packages/git/light.js';
import { claimCheckCeilingEnabled } from '../../../../../packages/config/index.js';
import { lineTuneEnabled } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
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
  if (first === 'run' && second === undefined && ctx.info.isMain && claimCheckCeilingEnabled()) await runRemeasure(io, ctx);
  if (first === 'run' && second === undefined && !values['health-only'] && !values['lapsed-only'] && lineTuneEnabled()) await runLineTune(io);
  return result;
}

/**
 * Re-take a pending check baseline for each open item whose check has no timed baseline, so checks frozen before claim.checkCeiling
 * are measured in the background after landing, bounded by the registered runner count, through the ordered editItem move [C7,#1273].
 * Why the unchanged check: edit's own baseline path takes the check and the pending record together, and the job then goes through the normal runner queue.
 * Why the catch: a refusal on one item is reported in the pass output and never fails the pass or stops the other items.
 */
async function runRemeasure(io, ctx) {
  const { prepareCheckBaseline } = await import('../../../../../packages/gate/heavy.js');
  const slots = (loadMachineSettings().runners ?? []).length;
  await withBoard(ctx, async board => {
    if (whoAmI(ctx, board).id !== 'coordinator') return;
    for (const item of remeasureCandidates(board, { slots })) {
      try {
        const baseline = prepareCheckBaseline(ctx.info.root, item.item_check);
        await ordered(ctx, board, 'editItem', [item.item_id, { agentId: 'coordinator', check: item.item_check, checkBaseline: baseline,
          barActor: barActorForCommand(ctx, board, { asPerson: false }) }]);
        if (baseline.result === 'pending') await launchBaseline(ctx, board, item.item_id, baseline);
        io.say(`remeasure #${item.item_id}: baseline requested`);
      } catch (error) {
        io.say(`remeasure #${item.item_id}: refused${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? error}`);
      }
    }
  });
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
