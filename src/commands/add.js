/** The pullboard add command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  checkBaseline,
  prepareCheckBaseline,
  refuseCheckSyntax,
  sayCheckBaseline,
} from '../check-baseline.js';
import {
  isLane,
} from '../lanes.js';
import {
  Refused,
} from '../refused.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../relay.js';
import {
  idProblems,
  loadSpec,
} from '../spec.js';
import {
  actOn,
  barActorForCommand,
  briefArg,
  briefInLane,
  buildInFilelessLane,
  idArg,
  idList,
  launchBaseline,
  ordered,
  personMode,
} from '../cli.js';

/** Run `pullboard add` and return its exit code. */
export async function run(io, args) {
  const command = 'add';
  const { first, second, rest, values } = args;
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    const id = recovered.result;
    io.result?.({ item: store.getItem(board, id) });
    io.say(`#${id}`);
    sayCheckBaseline(io, store.getItem(board, id));
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
    return 0;
  }
  if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
  const specIds = idList(values.specs);
  const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds, ctx.doctrine);
  if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}`);
  const parentId = values.parent ? idArg(values.parent, 'a parent item id') : null;
  const after = idList(values.after).map((text) => idArg(text, 'an item id after --after'));
  const title = [second, ...rest].filter(Boolean).join(' ');
  const item = {
    by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id,
    lane: first,
    title,
    criterion: values.criterion ?? '',
    specIds,
    parentId,
    after,
    brief: briefInLane(ctx, first, briefArg(io, values) ?? ''),
    reviewFamily: values['review-family'],
    route: values.route ?? 'strong',
    check: values.check,
  };
  buildInFilelessLane(ctx.config, first, after);
  const { command } = store.validateItemAddition(board, item);
  if (command) refuseCheckSyntax(command);
  if (command) item.checkBaseline = values.wait ? checkBaseline(ctx.info.root, command) : prepareCheckBaseline(ctx.info.root, command);
  item.barActor = barActorForCommand(ctx, board, { asPerson: personMode(ctx, me, values) });
  const id = await ordered(ctx, board, 'addItem', [item]);
  if (item.checkBaseline?.result === 'pending') await launchBaseline(ctx, board, id, item.checkBaseline);
  io.result?.({ item: store.getItem(board, id) });
  io.say(`#${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
