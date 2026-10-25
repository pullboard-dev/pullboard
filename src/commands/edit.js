import { barReadySetting } from '../bar-readiness.js';
/** The pullboard edit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  checkBaseline,
  prepareCheckBaseline,
  refuseCheckSyntax,
  sayCheckBaseline,
} from '../check-baseline.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../relay.js';
import {
  actOn,
  barActorForCommand,
  briefArg,
  briefInLane,
  editAfter,
  freezer,
  idArg,
  launchBaseline,
  ordered,
  personMode,
} from '../cli.js';

/** Run `pullboard edit` and return its exit code. */
export async function run(io, args) {
  const command = 'edit';
  const { first, values } = args;
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const id = idArg(first);
  const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    io.result?.({ item: store.getItem(board, id) });
    io.say(`edited #${id}`);
    sayCheckBaseline(io, store.getItem(board, id));
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
    return 0;
  }
  const brief = briefArg(io, values);
  const change = {
    agentId: me.id,
    brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
    route: values.route,
    criterion: values.criterion,
    check: values.check,
    after: editAfter(values.after),
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
  };
  const { item, next, command } = store.validateItemEdit(board, id, change);
  if (me.id === 'coordinator' && ['item_criterion', 'item_check', 'item_after'].some(key => next[key] !== item[key])) {
    change.correction = true;
    change.freeze = freezer(ctx, { captureVerifyPolicy: true, board });
  }
  if (command && command !== item.item_check) refuseCheckSyntax(command);
  if (command && (command !== item.item_check || barReadySetting(board).enabled)) change.checkBaseline = values.wait ? checkBaseline(ctx.info.root, command) : prepareCheckBaseline(ctx.info.root, command);
  change.barActor = barActorForCommand(ctx, board, { asPerson: personMode(ctx, me, values) });
  await ordered(ctx, board, 'editItem', [id, change]);
  if (change.checkBaseline?.result === 'pending') await launchBaseline(ctx, board, id, change.checkBaseline);
  io.result?.({ item: store.getItem(board, id) });
  io.say(`edited #${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
