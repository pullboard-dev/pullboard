/** Ask another lane for one durable child rather than starting duplicate companion work [B2,B12]. */
import * as store from '../../../../../packages/store/index.js';
import { isLane } from '../../../../../packages/seats/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { idProblems } from '../../../../../packages/spec/index.js';
import { loadSpec } from '../../../../../packages/spec/index.js';
import { checkBaseline } from '../../../../../packages/gate/index.js';
import { prepareCheckBaseline } from '../../../../../packages/gate/index.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { launchBaseline } from '../add.js';
import { refuseCheckSyntax } from '../../../../../packages/gate/index.js';
import { sayCheckBaseline } from '../../../../../packages/gate/index.js';
import { relayCommandReceipt } from '../../../../../packages/link/index.js';
import { relayCommandReceiptReported } from '../../../../../packages/link/index.js';
import { actOn } from '../entry.js';
import { barActorForCommand } from '../entry.js';
import { briefArg } from '../entry.js';
import { briefInLane } from '../entry.js';
import { idArg } from '../entry.js';
import { idList } from '../entry.js';
import { ordered } from '../entry.js';
import { buildInFilelessLane } from '../entry.js';
import { criterionCells } from '../../../../../packages/items/index.js';
import { defaultItemRoute } from '../../../../../packages/items/index.js';

/** Execute the normal authenticated request; only the coordinator may supply a check command. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
    let result, pending = null;
    if (recovered) {
      io.recordedMove = true;
      for (const event of recovered.events) io.onEvent?.(event);
      result = recovered.result;
    } else {
      if (!isLane(ctx.config, second)) throw new Refused('NO_LANE', `no lane "${second ?? ''}"; see pullboard lanes`);
      const specIds = idList(values.specs);
      const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds, ctx.doctrine);
      if (problems.length) throw new Refused('UNKNOWN_SPEC', problems.join('; '));
      buildInFilelessLane(ctx.config, second, []);
      const request = { agentId: me.id, parentId: idArg(first), lane: second, key: values.key,
        title: rest.join(' '), criterion: values.criterion ?? '', specIds,
        brief: briefInLane(ctx, second, briefArg(io, values) ?? ''), route: values.route ?? defaultItemRoute(values.criterion ?? '', criterionCells(ctx.info.root)), check: values.check,
        barActor: barActorForCommand(ctx, board, { asPerson: false }) };
      const plan = store.planCompanion(board, request);
      if (!plan.existing && plan.validated.command) {
        refuseCheckSyntax(plan.validated.command);
        // Under gate.runnersOnly the Mac never clones and runs the check: capture the request only and let the baseline
        // worker measure it on a runner (or record it unavailable), as add and edit do [C7,E28,#5889].
        request.checkBaseline = gateRunnerAdmission().runnerOnly === true
          ? prepareCheckBaseline(ctx.info.root, plan.validated.command)
          : checkBaseline(ctx.info.root, plan.validated.command);
      }
      result = await ordered(ctx, board, 'requestCompanion', [request]);
      if (result.created && request.checkBaseline?.result === 'pending') pending = request.checkBaseline;
    }
    if (pending) await launchBaseline(ctx, board, result.item, pending);
    const item = store.getItem(board, result.item);
    io.result?.({ item, created: result.created });
    io.say(`${result.created ? 'created' : 'existing'} companion #${item.item_id} in ${item.item_lane}; claim that item before building it`);
    sayCheckBaseline(io, item);
    if (recovered) await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  });
}
