import { frozenCheckTiming } from "../../logic/check/timing.js";
import { browserFreeChecksEnabled } from "../../../../config/index.js";
import { requireOutsideReceipt } from "./proof.js";
/** Outside verification uses the ordinary native verdict authority but never checks out its executable tree. */
import {
  headCommit,
  isClean,
  untracked,
} from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";

/** Accept only a bound sandbox result; rejection does not execute contributed programs. */
export async function outsideVerdict(ctx, board, item, me, decision, values, ports) {
  const { checkNeedsBrowser, freezer, ordered, resourceAgent, textArg, withGateSlot, verifyOutsideSandbox, itemPolicy, requireTrunkMerge, executionServices } = ports;
  if (decision === 'ACCEPT' && !values.sandbox) throw new Refused('OUTSIDE_SANDBOX_REQUIRED', `outside code cannot be verified on the host; run pullboard verify ${item.item_id} accept --sandbox --note "what you checked"`);
  const policy = itemPolicy(ctx.info.root, item);
  const digest = freezer(ctx, { board })(item).digest;
  if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', 'the trusted outside criterion changed; ask the coordinator to refreeze it');
  let sandbox;
  let review;
  if (decision === 'ACCEPT') {
    if (!isClean(ctx.info.root) || untracked(ctx.info.root).length) throw new Refused('DIRTY', 'commit the trusted reviewing checkout before sandbox verification');
    const head = headCommit(ctx.info.root);
    const trunk = requireTrunkMerge(ctx.info.root, item.item_commit);
    const command = JSON.parse(item.item_frozen).check;
    const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(ctx.info.root, command, { commit: item.item_commit })
      || await checkNeedsBrowser(ctx.info.root, policy.config.gate, { commit: item.item_commit });
    sandbox = await withGateSlot(ctx.info.root, lease => verifyOutsideSandbox(ctx.info.root, item, policy, lease),
      { executionServices, remote: false, browser, agent: resourceAgent(ctx), item: String(item.item_id), kind: 'review', timing: frozenCheckTiming(item), itemCheck: true });
    requireOutsideReceipt(board, sandbox);
    if (headCommit(ctx.info.root) !== head || !isClean(ctx.info.root) || untracked(ctx.info.root).length) throw new Refused('NOT_AT_COMMIT', 'the trusted reviewing checkout moved during sandbox verification; restore its clean head before reviewing again');
    const after = requireTrunkMerge(ctx.info.root, item.item_commit);
    if (after.commit !== trunk.commit) throw new Refused('VERDICT_TRUNK_MOVED', 'main moved during sandbox verification; review the outside change against current main');
    review = { commit: item.item_commit, head: item.item_commit, trunk: trunk.commit, paths: [...new Set([...(item.outside.files ?? []), 'pullboard.json', 'SPEC.md', 'DOCTRINE.md'])].sort() };
  }
  return ordered(ctx, board, 'verify', [item.item_id, { agentId: me.id, decision, reason: values.reason,
    note: textArg(ctx.io, values, 'note') ?? '', head: item.item_commit, digest, policy: policy.config.verify.policy, familyPolicy: policy.config.verify.family,
    ...(decision === 'ACCEPT' ? { sandbox, review, check: 'green', environment: sandbox.runs[1].environment } : { cause: values.cause }) }]);
}
