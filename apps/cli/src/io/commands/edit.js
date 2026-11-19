import { requireBarPathsOnMain } from '../item/bar.js';
import { requireTestMirror } from '../item/bar.js';
import { requireSpecGateRows } from '../item/bar.js';
import { COORDINATOR } from '../item/bar.js';
import { itemsTestMirrorAtAdd } from '../../../../../packages/config/index.js';
import { itemsBarRulesAtAdd } from '../../../../../packages/config/index.js';
import { requireOwnLaneCheck } from '../lane.js';
import { guardBar } from '../../../../../packages/state/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
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
  gateFiles,
  parseSpec,
  referenceAuthors,
  referenceAuthority,
} from '../../../../../packages/spec/index.js';
/** The pullboard edit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  prepareCheckBaseline,
  refuseCheckSyntax,
  refuseCheckPullboardTest,
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
} from '../entry.js';

const fs = fileSystemAdapter();

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
    const filed = store.getItem(board, id);
    io.result?.({ item: filed, route: filed.item_route, level: filed.item_route, review: filed.item_review_tier ?? 'standard', review_tier: filed.item_review_tier ?? 'standard' });
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
    ...(values['machine-commands-file'] === undefined ? {} : { machineCommands: JSON.parse(fs.readFile(values['machine-commands-file'], 'utf8')) }),
    ...(values.title === undefined ? {} : { title: values.title }),
    brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
    reviewFamily: values['review-family'],
    ...(values['review-tier'] === undefined ? {} : { reviewTier: values['review-tier'] }),
    ...(values.readiness === undefined ? {} : { readinessCommand: values.readiness }),
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
  const barWarnings = sealed ? [] : guardBar(change.criterion, { allowLong: Boolean(values['force-size']?.trim()) });
  // A changed bar may not name a path missing from main, refused before any other bar rule; an edit that leaves the
  // criterion and check alone never refuses on it (#5709).
  if (change.criterion !== undefined || change.check !== undefined) {
    const before = store.getItem(board, id);
    if (change.check) refuseCheckPullboardTest(change.check);
    await requireBarPathsOnMain(ctx, { criterion: change.criterion ?? before.item_criterion, check: change.check ?? before.item_check });
    await requireTestMirror(ctx, { criterion: change.criterion ?? before.item_criterion, check: change.check ?? before.item_check }, itemsTestMirrorAtAdd());
    await requireSpecGateRows(ctx, { criterion: change.criterion ?? before.item_criterion }, itemsBarRulesAtAdd(), asPerson || me.id === COORDINATOR, { parseSpec, gateFiles });
  }
  const { item, next, command, widened, evidenceWarnings = [] } = store.validateItemEdit(board, id, change);
  if ((me.id === 'coordinator' || widened) && ['item_criterion', 'item_check', 'item_after', 'item_check_timing'].some(key => next[key] !== item[key])) {
    change.correction = true;
    change.freeze = freezer(ctx, { captureVerifyPolicy: true, board });
  }
  if (command && command !== item.item_check) refuseCheckSyntax(command);
  if (command && (command !== item.item_check || barReadySetting(board).enabled)) change.checkBaseline = prepareCheckBaseline(ctx.info.root, command);
  if (command && command !== item.item_check && !sealed) store.guardGreenCheck(board, change.checkBaseline, values['accept-green']);
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
  const warnings = [...evidenceWarnings, ...barWarnings];
  const filed = store.getItem(board, id);
  io.result?.({ item: filed, route: filed.item_route, level: filed.item_route, review: filed.item_review_tier ?? 'standard', review_tier: filed.item_review_tier ?? 'standard', ...(warnings.length ? { warnings } : {}) });
  for (const warning of warnings) io.err(`warning: [${warning.code ?? 'BAR'}] ${warning.message}`);
  io.say(`edited #${id}`);
  sayCheckBaseline(io, store.getItem(board, id));
  return 0;
});
}
