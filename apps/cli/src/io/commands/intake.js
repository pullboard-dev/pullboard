/** Intake records an outside source; fetching metadata never executes or checks out its code. */
import * as store from '../../../../../packages/store/index.js';
import {
  actOn,
  freezer,
  idArg,
  ordered,
} from '../entry.js';
import { githubSource } from '../../../../../packages/github/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { criterionCells } from '../../../../../packages/items/index.js';
import { defaultItemRoute } from '../../../../../packages/items/index.js';

/** Run intake or the explicit owner approval; there is deliberately no autonomous posting path. */
export async function run(io, { first, second, values }) {
  return actOn(io, async (ctx, board, me) => {
    if (first === 'approve') {
      requirePersonChannel(io.personChannel);
      const id = idArg(second);
      const approval = await ordered(ctx, board, 'approveOutside', [id, { agentId: 'person' }]);
      io.result?.({ id, approval });
      io.say(`owner approved outside commit for #${id}`);
      return 0;
    }
    const source = githubSource(ctx.info.root, first);
    const lane = values.lane ?? (ctx.config.lanes[me.lane] ? me.lane : Object.keys(ctx.config.lanes)[0]);
    if (!lane || !ctx.config.lanes[lane]) throw new Refused('NO_LANE', 'choose a configured lane with --lane before intake');
    if (source.kind === 'pull-request' && (!values.criterion?.trim() || !values.check?.trim())) throw new Refused('CHECK_REQUIRED', 'intake a pull request with --criterion "behavior" --check "command" from the trusted coordinator checkout');
    const item = { lane, title: source.title, criterion: values.criterion ?? '', check: values.check, specIds: [], route: values.route ?? (values.check?.trim() ? defaultItemRoute(values.criterion ?? '', criterionCells(ctx.info.root)) : 'strong') };
    const frozen = source.kind === 'pull-request' ? freezer(ctx, { board, captureVerifyPolicy: true })({ item_title: item.title, item_criterion: item.criterion, item_check: item.check, item_spec_ids: '' }) : null;
    const id = await ordered(ctx, board, 'intakeOutside', [{ agentId: me.id, source, item, frozen }]);
    io.result?.({ item: store.getItem(board, id) });
    io.say(`intaken ${source.kind} #${source.number} as #${id}; outside code is verified only with --sandbox`);
    return 0;
  });
}
