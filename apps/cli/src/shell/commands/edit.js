import { requireOwnLaneCheck } from '../lane-check.js';
import { readFileSync } from 'node:fs';
import { Refused } from '../../../../../packages/kernel/index.js';
import { parseExpectedBuildMinutes } from '../../../../../packages/items/index.js';
import { parseCheckTiming } from '../../../../../packages/items/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { githubPullClient } from '../../../../../packages/github/index.js';
import {
  confirmBarEffect,
  executingBarEffect,
  personBarMode,
} from '../../../../../packages/person/index.js';
import { barReadySetting } from '../../../../../packages/verify/index.js';
import {
  referenceAuthors,
  referenceAuthority,
} from '../../../../../packages/spec/index.js';
/** The pullboard edit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  prepareCheckBaseline,
  refuseCheckSyntax,
  sayCheckBaseline,
} from '../../../../../packages/gate/index.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../../../../../packages/link/index.js';
import {
  actOn,
  personMode,
  barActorForCommand,
  briefArg,
  briefInLane,
  editAfter,
  freezer,
  idArg,
  launchBaseline,
  ordered,
  CHECKOUT_LEASES,
} from '../cli.js';

/** Run `pullboard edit` and return its exit code. */
export async function run(io, args) {
  const command = 'edit';
  const { first, values } = args;
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const id = idArg(first);
  const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    io.result?.({ item: store.getItem(board, id) });
    io.say(`edited #${id}`);
    sayCheckBaseline(io, store.getItem(board, id));
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  }
  const sealed = executingBarEffect(ctx, board, 'edit', id);
  const brief = sealed ? sealed.brief : briefArg(io, values);
  if (values['machine-verified'] !== undefined && !['on', 'off'].includes(values['machine-verified'])) throw new Refused('USAGE', '--machine-verified on|off');
  if (values['machine-commands-file'] !== undefined && me.id !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator marks machine verification');
  let change = {
    agentId: me.id,
    ...(values['machine-verified'] === undefined ? {} : { machineVerified: values['machine-verified'] === 'on' }),
    ...(values['machine-commands-file'] === undefined ? {} : { machineCommands: JSON.parse(readFileSync(values['machine-commands-file'], 'utf8')) }),
    brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
    reviewFamily: values['review-family'],
    ...(values['review-tier'] === undefined ? {} : { reviewTier: values['review-tier'] }),
    ...(values['expected-minutes'] === undefined ? {} : { expectedBuildMinutes: parseExpectedBuildMinutes(values['expected-minutes']) }),
    route: values.route,
    ...(values.sensitive === undefined ? {} : { sensitive: values.sensitive }),
    ...(values['review-family'] === undefined ? {} : { reviewFamily: values['review-family'] }),
    criterion: values.criterion,
    check: values.check,
    ...(values['check-timing'] === undefined ? {} : { checkTiming: parseCheckTiming(values['check-timing']) }),
    after: editAfter(values.after),
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
  };
  if (sealed) change = { ...sealed };
  const asPerson = personBarMode(ctx, board, me, values, personMode);
  const confirmed = await confirmBarEffect(ctx, board, me, { verb: 'edit', item: id,
    args: { as: 'person', ...(values.wait ? { wait: true } : {}) } }, change, asPerson);
  if (confirmed !== null) return confirmed;
  if (change.brief !== undefined) {
    const authority = referenceAuthority(ctx, me.id, change.brief, store.getItem(board, id).item_brief, { requirePersonChannel });
    if (authority) change.referenceAuthority = authority;
    const authors = referenceAuthors(ctx.info.root, change.brief, { githubPullClient });
    if (authors.length) change.referenceAuthors = authors;
  }
  requireOwnLaneCheck(ctx.config, me, store.getItem(board, id).item_lane, change.check);
  const { item, next, command, widened, evidenceWarnings = [] } = store.validateItemEdit(board, id, change);
  if ((me.id === 'coordinator' || widened) && ['item_criterion', 'item_check', 'item_after', 'item_check_timing'].some(key => next[key] !== item[key])) {
    change.correction = true;
    change.freeze = freezer(ctx, { captureVerifyPolicy: true, board });
  }
  if (command && command !== item.item_check) refuseCheckSyntax(command);
  if (command && (command !== item.item_check || barReadySetting(board).enabled)) change.checkBaseline = prepareCheckBaseline(ctx.info.root, command);
  change.barActor = barActorForCommand(ctx, board, { asPerson });
  await ordered(ctx, board, 'editItem', [id, change]);
  if (change.checkBaseline?.result === 'pending') {
    // The baseline worker measures it on a runner like any gate run; --wait only waits for its recorded result,
    // so an edit never runs the check on this machine itself [C7,#2520].
    await launchBaseline(ctx, board, id, change.checkBaseline);
    if (values.wait) {
      // The recorded move is complete; do not hold checkout authority while the worker measures.
      CHECKOUT_LEASES.get(io)?.release();
      CHECKOUT_LEASES.delete(io);
      /** Whether this edit's own baseline request is still being measured. */
      const measuring = () => {
        const baseline = store.getItem(board, id).item_check_baseline;
        return baseline?.result === 'pending' && baseline.request === change.checkBaseline.request;
      };
      while (measuring()) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  io.result?.({ item: store.getItem(board, id), ...(evidenceWarnings.length ? { warnings: evidenceWarnings } : {}) });
  for (const warning of evidenceWarnings) io.err(warning.message);
  io.say(`edited #${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
