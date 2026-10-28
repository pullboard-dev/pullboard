import { checkAtCommit } from '../runner-private-check.js';
/** The pullboard check command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from '../browser-admission.js';
import {
  checkAcceptCommand,
} from '../check-accept.js';
import {
  firstInputLine,
} from '../cli-support.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  digestOf,
  refuseSandboxBlocked,
  runStaticChecks,
  timingDigest,
  withGateSlot,
} from '../gate.js';
import * as nativeFlakes from '../native-flake-cli.js';
import {
  Refused,
} from '../refused.js';
import * as seatCheckout from '../seat-checkout.js';
import {
  browserFreeChecksEnabled,
} from '../settings.js';
import {
  frozenCheck,
  itemPolicy,
  mainPolicy,
} from '../trusted-policy.js';
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
} from '../cli.js';

/** Run `pullboard check` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'accept') return checkAcceptCommand(io, second, rest, { context, withBoard, whoAmI, ordered, idArg });
  const ctx = context(io);
  const { item, author, caller, agents } = withBoard(ctx, (board) => {
    const me = first ? (ctx.info.isMain ? { id: COORDINATOR } : { id: store.agentAt(board, ctx.info.root)?.agent_id }) : whoAmI(ctx, board);
    const held = first ? store.getItem(board, idArg(first))
      : store.listItems(board).find((entry) => entry.item_status === 'claimed' && entry.item_owner === me.id && entry.item_parent_id === null);
    if (!held) throw new Refused('NOT_HOLDING', 'you hold no item; name one, pullboard check <id>, or run the project gate: pullboard gate');
    seatCheckout.refuseHeldElsewhere(ctx.info, store.listAgents(board), held, 'check');
    return { item: held, author: store.itemCheckAuthor(board, held.item_id), caller: me.id, agents: store.listAgents(board) };
  });
  const check = frozenCheck(item);
  if (!check) throw new Refused('NO_CHECK', `#${item.item_id} has no check command; its proof is the project gate: pullboard gate`);
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
  await runStaticChecks(ctx.info.root, (item.item_claim_head ? itemPolicy(ctx.info.root, item) : mainPolicy(ctx.info.root)).config, { agent: caller, item: String(item.item_id), onWait: queuedItemLease(ctx, item, caller, 'build'), onBrowserFallback: browserAdmissionReporter(io, values.json) });
  const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(ctx.info.root, check, { onFallback: browserAdmissionReporter(io, values.json) });
  const shortEligible = Boolean(await explicitCheckFiles(ctx.info.root, check));
  const run = await withGateSlot(ctx.info.root, nativeFlakes.check(ctx, item, check, { ordered, withBoard, resourceAgent, checkAtCommit }), { browser, agent: caller, item: String(item.item_id), kind: 'check', itemCheck: true, shortEligible, onWait: queuedItemLease(ctx, item, caller, 'build') });
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
  return run.isGreen ? 0 : 1;
}
