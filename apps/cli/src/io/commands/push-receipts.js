import { boardReceiptStore } from '../../../../../packages/gate/heavy.js';
import { readGateReceipt } from '../../../../../packages/gate/heavy.js';
import { receiptBinds } from '../../../../../packages/gate/heavy.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { policyAt } from '../../../../../packages/sandbox/index.js';
import { checkNeedsBrowser } from '../../../../../packages/gate/heavy.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { checkNeedsGui } from '../../../../../packages/gate/heavy.js';
import { runProfiledShellAsync } from '../../../../../packages/gate/heavy.js';
import { withGateSlot } from '../../../../../packages/gate/heavy.js';
/** Additive receipt check; the existing pre-push hook remains the only active hook [C7]. */
import {
  context,
  resourceAgent,
  withBoardRead,
} from '../entry.js';
import { readStdin } from '../hook/stdin.js';
import {
  headCommit,
  headTree,
  isClean,
} from '../../../../../packages/git/index.js';
import { pushedFirstParentCommits } from '../../../../../packages/git/index.js';
import { nativePushReceiptProblems } from '../../../../../packages/git/index.js';
import { runPushReceiptSmoke } from '../../../../../packages/sandbox/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';

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
  const evidencePorts = { boardReceiptStore, readGateReceipt, receiptBinds, gateRuns, getItem, coordinator: COORDINATOR, policyAt };
  const problems = await withBoardRead(ctx, board => nativePushReceiptProblems(root, board, commits, evidencePorts));
  if (problems.length) {
    io.result?.({ green: false, commits, problems, activated: false });
    for (const problem of problems) io.err(problem);
    return 1;
  }
  const smoke = await runPushReceiptSmoke(root, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: resourceAgent(ctx), onWait: io.gateWaitReporter(io) },
    { checkNeedsBrowser, checkNeedsGui, runProfiledShellAsync, withGateSlot });
  if (headCommit(root) !== head || headTree(root) !== tree || !isClean(root)
    || mainPolicy(root).commit !== policy.commit || smoke.policyCommit !== policy.commit) {
    throw new Refused('PUSH_SOURCE_CHANGED', 'source or accepted policy changed during the smoke; inspect it and check the push again');
  }
  // Re-read ordered evidence after admission/execution; a newly red audit must not be skipped.
  const current = await withBoardRead(ctx, board => nativePushReceiptProblems(root, board, commits, evidencePorts));
  const green = smoke.isGreen && current.length === 0;
  io.result?.({ green, commits, problems: current, smoke, activated: false });
  if (smoke.output) io.say(smoke.output.trimEnd());
  for (const problem of current) io.err(problem);
  io.err(`additive push receipt check: ${green ? 'green' : 'red'}; existing pre-push hook unchanged`);
  return green ? 0 : 1;
}
