import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../person-bar-cli.js';
import { barReadySetting } from '../bar-readiness.js';
import {
  referenceAuthors,
  referenceAuthority,
} from '../reference-authors.js';
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
  const sealed = executingBarEffect(ctx, board, 'edit', id);
  const brief = sealed ? sealed.brief : briefArg(io, values);
  let change = {
    agentId: me.id,
    brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
    reviewFamily: values['review-family'],
    route: values.route,
    ...(values.sensitive === undefined ? {} : { sensitive: values.sensitive }),
    ...(values['review-family'] === undefined ? {} : { reviewFamily: values['review-family'] }),
    criterion: values.criterion,
    check: values.check,
    after: editAfter(values.after),
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
  };
  if (sealed) change = { ...sealed };
  const asPerson = personBarMode(ctx, board, me, values);
  const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'edit', item: id,
    args: { as: 'person', ...(values.wait ? { wait: true } : {}) } }, change, asPerson);
  if (confirmed !== null) return confirmed;
  if (change.brief !== undefined) {
    const authority = referenceAuthority(ctx, me.id, change.brief, store.getItem(board, id).item_brief);
    if (authority) change.referenceAuthority = authority;
    const authors = referenceAuthors(ctx.info.root, change.brief);
    if (authors.length) change.referenceAuthors = authors;
  }
  const { item, next, command } = store.validateItemEdit(board, id, change);
  if (me.id === 'coordinator' && ['item_criterion', 'item_check', 'item_after'].some(key => next[key] !== item[key])) {
    change.correction = true;
    change.freeze = freezer(ctx, { captureVerifyPolicy: true, board });
  }
  if (command && command !== item.item_check) refuseCheckSyntax(command);
  if (command && (command !== item.item_check || barReadySetting(board).enabled)) change.checkBaseline = values.wait ? checkBaseline(ctx.info.root, command) : prepareCheckBaseline(ctx.info.root, command);
  change.barActor = barActorForCommand(ctx, board, { asPerson });
  await ordered(ctx, board, 'editItem', [id, change]);
  if (change.checkBaseline?.result === 'pending') await launchBaseline(ctx, board, id, change.checkBaseline);
  io.result?.({ item: store.getItem(board, id) });
  io.say(`edited #${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
