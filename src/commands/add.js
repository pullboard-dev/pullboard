import { parseCheckTiming } from '../check-timing.js';
import { criterionSize } from '../../packages/items/index.js';
import { criterionCells } from '../../packages/items/index.js';
import { requirePersonChannel } from '../../packages/person/index.js';
import { githubPullClient } from '../pr-github.js';
import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../../packages/person/index.js';
import { dependencyValues } from '../../packages/items/index.js';
import {
  referenceAuthors,
  referenceAuthority,
} from '../../packages/spec/index.js';
/** The pullboard add command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  checkBaseline,
  refuseCheckSyntax,
  sayCheckBaseline,
} from '../../packages/gate/index.js';
import {
  isLane,
} from '../lanes.js';
import {
  Refused,
} from '../../packages/kernel/index.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../../packages/link/index.js';
import {
  idProblems,
  loadSpec,
} from '../../packages/spec/index.js';
import {
  actOn,
  personMode,
  barActorForCommand,
  briefArg,
  briefInLane,
  buildInFilelessLane,
  idArg,
  idList,
  ordered,
} from '../cli.js';

/** Run `pullboard add` and return its exit code. */
export async function run(io, args) {
  const command = 'add';
  const { first, second, rest, values } = args;
  const act = (work) => actOn(io, work, { privateBoard: values.private === true });
  return act(async (ctx, board, me) => {
  const recovered = values.private ? null : await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    const id = recovered.result;
    io.result?.({ item: store.getItem(board, id) });
    io.say(`#${id}`);
    sayCheckBaseline(io, store.getItem(board, id));
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  }
  if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
  const specIds = idList(values.specs);
  const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds, ctx.doctrine);
  if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}`);
  const parentId = values.parent ? idArg(values.parent, 'a parent item id') : null;
  const after = dependencyValues(idList(values.after));
  const title = [second, ...rest].filter(Boolean).join(' ');
  let item = {
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
    ...(values.sensitive === undefined ? {} : { sensitive: values.sensitive }),
    ...(values['review-family'] === undefined ? {} : { reviewFamily: values['review-family'] }),
    check: values.check,
    ...(values['check-timing'] === undefined ? {} : { checkTiming: parseCheckTiming(values['check-timing']) }),
  };
  const sealed = executingBarEffect(ctx, board, 'add');
  if (sealed) item = { ...sealed };
  if (sealed) {
    const sealedProblems = idProblems(loadSpec(ctx.info.root, ctx.config), item.specIds, ctx.doctrine);
    if (sealedProblems.length) throw new Refused('UNKNOWN_SPEC', sealedProblems.join('; '));
    briefInLane(ctx, item.lane, item.brief);
  }
  const asPerson = personBarMode(ctx, board, me, values, personMode);
  const size = criterionSize(item.criterion, criterionCells(ctx.info.root));
  const sizeReason = values['force-size']?.trim();
  if (values['force-size'] !== undefined && !sizeReason) throw new Refused('ITEM_SIZE_REASON', '--force-size needs a nonempty reason', 'use --force-size "why this scope must stay together"');
  if (size.oversized && !sizeReason) throw new Refused('ITEM_TOO_LARGE', `criterion names ${size.cells.length} cells and ${size.clauses} clauses (size ${size.score})`,
    `split it into one item per named cell (${size.cells.join(', ') || 'none'}) and at most three numbered clauses per item; or use --force-size "reason"`);
  const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'add', args: {
    lane: item.lane, title: item.title, ...(values.wait ? { wait: true } : {}), as: 'person',
  } }, item, asPerson);
  if (confirmed !== null) return confirmed;
  buildInFilelessLane(ctx.config, item.lane, item.after);
  const authority = referenceAuthority(ctx, me.id, item.brief, undefined, { requirePersonChannel });
  if (authority) item.referenceAuthority = authority;
  const authors = referenceAuthors(ctx.info.root, item.brief, { githubPullClient });
  if (authors.length) item.referenceAuthors = authors;
  const { command } = store.validateItemAddition(board, item);
  if (command) refuseCheckSyntax(command);
  if (command) item.checkBaseline = checkBaseline(ctx.info.root, command);
  item.barActor = barActorForCommand(ctx, board, { asPerson });
  const id = await ordered(ctx, board, 'addItem', [item]);
  if (sizeReason) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
    text: `Criterion size override: ${sizeReason}\n${JSON.stringify(size)}` }]);
  io.result?.({ item: store.getItem(board, id) });
  io.say(`#${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
