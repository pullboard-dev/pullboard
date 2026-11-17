import { seatAt } from '../item/folder/identity.js';
import { recordCheckTicks } from './submit.js';
import { frozenCheckTiming } from '../../../../../packages/items/index.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
/** The pullboard check command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  checklistGaps,
  checklistReceipt,
  reviewChecklist,
} from '../../../../../packages/state/index.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from '../../../../../packages/gate/index.js';
import {
  checkAcceptCommand,
} from '../../../../../packages/verify/index.js';
import {
  firstInputLine,
} from '../support.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  digestOf,
  refuseSandboxBlocked,
  runStaticChecks,
  timingDigest,
  withGateSlot,
} from '../../../../../packages/gate/index.js';
import {
  check as flakeCheck,
} from '../../../../../packages/flakes/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { refuseHeldElsewhere } from '../../../../../packages/seats/index.js';
import {
  browserFreeChecksEnabled,
  heavyLocalHoldEnabled,
  loadMachineSettings,
} from '../../../../../packages/config/index.js';
import { withHeavyLocalWork } from '../../../../../packages/resources/index.js';
import {
  frozenCheck,
  itemPolicy,
  mainPolicy,
} from '../../../../../packages/sandbox/index.js';
import {
  agentDisplayName,
  browserAdmissionReporter,
  context,
  idArg,
  ordered,
  queuedItemLease,
  resourceAgent,
  whoAmI,
  withBoard,
} from '../entry.js';

/** Run `pullboard check` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'accept') return checkAcceptCommand(io, second, rest, { context, withBoard, whoAmI, ordered, idArg, requirePersonChannel });
  const ctx = context(io);
  const { item, author, caller, agents } = withBoard(ctx, (board) => {
    const me = first ? (ctx.info.isMain ? { id: COORDINATOR } : { id: seatAt(board, ctx.info.root)?.agent_id }) : whoAmI(ctx, board);
    const held = first ? store.getItem(board, idArg(first))
      : store.listItems(board).find((entry) => entry.item_status === 'claimed' && entry.item_owner === me.id && entry.item_parent_id === null);
    if (!held) throw new Refused('NOT_HOLDING', 'you hold no item; name one, pullboard check <id>, or run the project gate: pullboard gate');
    refuseHeldElsewhere(ctx.info, store.listAgents(board), held, 'check', agentSessionDigest);
    return { item: held, author: store.itemCheckAuthor(board, held.item_id), caller: me.id, agents: store.listAgents(board) };
  });
  const check = frozenCheck(item);
  if (!check) {
    // No test check, but a numbered criterion: the review checklist is the proof, and the board says which lines name no evidence (#996).
    const thread = withBoard(ctx, board => store.itemThread(board, item.item_id));
    if (!reviewChecklist(item, thread).length) throw new Refused('NO_CHECK', `#${item.item_id} has no check command; its proof is the project gate: pullboard gate`);
    const gaps = checklistGaps(item, thread);
    if (gaps.length) throw new Refused('CLAUSE_UNTICKED', `#${item.item_id} has no test check; its review checklist is not met: ${gaps.join('; ')}`,
      `pullboard fact ${item.item_id} note "clause <n> [test|command|screenshot|measurement|reasoning]: <a file path, link or quoted passage>", then check again`);
    io.say(`checklist for #${item.item_id} names evidence on every line; the reviewer judges it: ${checklistReceipt(item, thread)}`);
    return 0;
  }
  const by = author || 'unknown (legacy)';
  const authorName = author ? agentDisplayName(agents, ctx.config, author) : by;
  const notice = `check #${item.item_id} set by ${authorName}: ${check}`;
  if (values.json) io.stderr.write(`${notice}\n`);
  else io.say(notice);
  if (!values.yes && (!author || author !== caller)) {
    if (values.json) io.stderr.write('Run this check? [y/N]\n');
    else io.err('Run this check? [y/N]');
    const answer = await firstInputLine(io.stdin);
    if (!/^y(?:es)?$/iu.test(answer.trim())) {
      throw new Refused('CHECK_CONFIRM', `the check set by ${authorName} was not run: ${check}; run pullboard check ${item.item_id} --yes after reading the command, or answer yes at the prompt`);
    }
  }
  await runStaticChecks(ctx.info.root, (item.item_claim_head ? itemPolicy(ctx.info.root, item) : mainPolicy(ctx.info.root)).config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: caller, item: String(item.item_id), onWait: queuedItemLease(ctx, item, caller, 'build'), onBrowserFallback: browserAdmissionReporter(io, values.json) });
  const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(ctx.info.root, check, { onFallback: browserAdmissionReporter(io, values.json) });
  const shortEligible = Boolean(await explicitCheckFiles(ctx.info.root, check));
  const runCheck = () => withGateSlot(ctx.info.root, flakeCheck(ctx, item, check, { ordered, withBoard, resourceAgent, checkAtCommit }), { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser, agent: caller, item: String(item.item_id), kind: 'check', timing: frozenCheckTiming(item), itemCheck: true, shortEligible, onWait: queuedItemLease(ctx, item, caller, 'build') });
  // With machine.holdHeavyAboveLoad on the whole check, runner or local, waits in the local resource line while this machine is over its load ceiling and says so; off, it runs as before [C7,#10078].
  const run = heavyLocalHoldEnabled() ? await withHeavyLocalWork('pullboard check', runCheck, { settings: loadMachineSettings, root: ctx.info.root, agent: caller }) : await runCheck();
  refuseSandboxBlocked(run);
  io.result?.({ id: item.item_id, green: run.isGreen, seconds: run.seconds, check, by, receipt: run.profile?.receipt, report: run.isGreen ? '' : digestOf(run.output) });
  const timings = timingDigest(run.profile);
  const compact = timings && !run.profile.files.length
    ? `; ${timings.replaceAll('\n', '; ')}; timing profile: ${run.profilePath}` : '';
  io.say(`check ${run.isGreen ? 'green' : 'red'} in ${run.seconds}s: ${check}${compact}`);
  if (timings && run.profile.files.length) {
    io.say(timings);
    io.say(`timing profile: ${run.profilePath}`);
  }
  if (!run.isGreen) io.say(digestOf(run.output).replace(/^/gm, '  '));
  if (run.isGreen) await recordCheckTicks(io, item.item_id);
  return run.isGreen ? 0 : 1;
}
