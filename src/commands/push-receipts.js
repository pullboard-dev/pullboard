import { checkNeedsBrowser } from '../browser-admission.js';
import { checkNeedsGui } from '../gui-admission.js';
import { runProfiledShellAsync } from '../gate.js';
import { withGateSlot } from '../gate.js';
/** Additive receipt check; the existing pre-push hook remains the only active hook [C7]. */
import {
  context,
  gateWaitReporter,
  resourceAgent,
  withBoardRead,
} from '../cli.js';
import { readStdin } from '../cli-support.js';
import {
  headCommit,
  headTree,
  isClean,
} from '../git.js';
import { pushedFirstParentCommits } from '../pre-push-receipts.js';
import { nativePushReceiptProblems } from '../push-native-evidence.js';
import { runPushReceiptSmoke } from '../push-receipt-smoke.js';
import { Refused } from '../refused.js';
import { mainPolicy } from '../trusted-policy-read.js';

/** Check actual pre-push stdin and native evidence, then run only the explicit accepted smoke policy. */
export async function run(io) {
  const ctx = context(io);
  const root = ctx.info.root;
  const policy = mainPolicy(root);
  const refs = typeof io.stdin === 'string' ? io.stdin : await readStdin(io.stdin);
  const commits = pushedFirstParentCommits(root, refs);
  if (!isClean(root)) throw new Refused('PUSH_SOURCE_CHANGED', 'commit or restore local changes before checking push receipts');
  const head = headCommit(root);
  const tree = headTree(root);
  const problems = await withBoardRead(ctx, board => nativePushReceiptProblems(root, board, commits));
  if (problems.length) {
    io.result?.({ green: false, commits, problems, activated: false });
    for (const problem of problems) io.err(problem);
    return 1;
  }
  const smoke = await runPushReceiptSmoke(root, { agent: resourceAgent(ctx), onWait: gateWaitReporter(io) },
    { checkNeedsBrowser, checkNeedsGui, runProfiledShellAsync, withGateSlot });
  if (headCommit(root) !== head || headTree(root) !== tree || !isClean(root)
    || mainPolicy(root).commit !== policy.commit || smoke.policyCommit !== policy.commit) {
    throw new Refused('PUSH_SOURCE_CHANGED', 'source or accepted policy changed during the smoke; inspect it and check the push again');
  }
  // Re-read ordered evidence after admission/execution; a newly red audit must not be skipped.
  const current = await withBoardRead(ctx, board => nativePushReceiptProblems(root, board, commits));
  const green = smoke.isGreen && current.length === 0;
  io.result?.({ green, commits, problems: current, smoke, activated: false });
  if (smoke.output) io.say(smoke.output.trimEnd());
  for (const problem of current) io.err(problem);
  io.err(`additive push receipt check: ${green ? 'green' : 'red'}; existing pre-push hook unchanged`);
  return green ? 0 : 1;
}
