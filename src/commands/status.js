import { withBoardRead } from '../cli-board-read.js';
/** The pullboard status command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board-query.js';
import { personNeedsSummary } from '../needs-summary.js';
import { identifyCaller } from '../cli-read-context.js';
import { relayStateExists } from '../local-state.js';
import { unlinkedRelayStatus } from '../relay-status-fields.js';
import { ruleProofCounts } from '../rule-proof-counts.js';
import { memoryHeldRuns } from '../memory-held.js';
import {
  runnerDeadlineLine,
  runnerDeadlineRuns,
} from '../runner-wait.js';
import {
  reviewQueueLine,
} from '../next-steps.js';
import {
  productLine,
  productSummaries,
} from '../products.js';
import { originRepository } from '../github-origin.js';
import {
  loadSpec,
} from '../spec.js';
import {
  submitInvariantLine,
  submitInvariantProposals,
} from '../submit-invariants.js';
import {
  context,
  span,
} from '../cli-read-context.js';

/** Run `pullboard status` and return its exit code. */
export async function run(io, { values }) {
  const ctx = context(io);
  const hasRelayState = relayStateExists(ctx.info.commonDir);
  const relay = hasRelayState ? await import('../relay.js') : null;
  const environment = hasRelayState && process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? await import('../relay-environment.js') : null;
  const summary = await withBoardRead(ctx, (board, readers) => {
    const me = identifyCaller(ctx, board, { environmentAgent: environment?.environmentAgent ?? (() => null),
      relayLinked: relay?.relayLinked ?? (() => false) }, readers);
    const mine = store.itemsInStatus(board, 'claimed', me.id);
    const agents = store.listAgents(board);
    const presenceCounts = { live: 0, idle: 0, gone: 0 };
    for (const seat of agents) presenceCounts[seat.presence] += 1;
    const approvalState = personNeedsSummary(ctx.info.root, { board, config: ctx.config, agents });
    return { me, mine, agents, presenceCounts, ruleCounts: ruleProofCounts(ctx.info.root, board, approvalState.spec), needs: approvalState.needs, specApprovalBaseline: approvalState.specApprovalBaseline, specApprovalEvidenceErrors: approvalState.specApprovalEvidenceErrors, stats: store.stats(board), reviewQueue: { ...store.reviewQueue(board), ...store.reviewQueueBreakdown(board) }, unread: store.unreadCount(board, me.id), relay: relay ? relay.relayStatus(ctx.info.root) : unlinkedRelayStatus(),
      submitInvariantProposals: submitInvariantProposals(store.submitInvariantEvents(board, ctx.config), ctx.config) };
  });
  summary.memoryHeld = memoryHeldRuns();
  summary.runnerDeadlines = runnerDeadlineRuns();
  if (values.json) {
    io.result(summary);
    return 0;
  }
  if (hasRelayState) for (const line of (await import('../relay-output.js')).briefLines(summary.relay)) io.say(line);
  const { items, accepted, rejected } = summary.stats;
  io.say(`${summary.me.displayName}: ${summary.unread} unread shouts; holding ${summary.mine.map((item) => `#${item.item_id}`).join(', ') || 'nothing'}`);
  io.say(`board: ${items.open} open, ${items.claimed} claimed, ${items.submitted} awaiting verification, ${items.verified} verified, ${items.withdrawn} withdrawn`);
  io.say(`verdicts: ${accepted} accepted, ${rejected} rejected`);
  if (summary.specApprovalBaseline?.pending) io.say('approval baseline pending: the next coordinator or person command in the main checkout records the existing approved rows; lane work may continue and none are flagged until then');
  if (summary.specApprovalBaseline?.invalid) io.say('approval baseline unreadable: existing rows need approval evidence; restore a known-good board export to recover the original baseline');
  io.say(reviewQueueLine(ctx, summary.reviewQueue, span));
  io.say(`seats: ${summary.presenceCounts.live} live, ${summary.presenceCounts.idle} idle, ${summary.presenceCounts.gone} gone`);
  for (const seat of summary.agents.filter(seat => values.all || seat.presence !== 'gone')) io.say(`${seat.agent_id}: ${seat.presence}${seat.heartbeatAt ? ` (heartbeat ${seat.heartbeatAt})` : ' (no local heartbeat)'}`);
  if (summary.memoryHeld === null) io.say('local memory hold status unavailable; pullboard resources shows the queue');
  else for (const run of summary.memoryHeld) io.say(`local memory holds ${run.agent}${run.item ? ` #${run.item}` : ''}${run.kind ? ` (${run.kind})` : ''}${run.repo ? ` in ${run.repo}` : ''}`);
  if (summary.runnerDeadlines === null) io.say('runner wait deadline status unavailable; pullboard resources shows the queue');
  else for (const run of summary.runnerDeadlines) io.say(`${run.agent}${run.item ? ` #${run.item}` : ''}${run.repo ? ` in ${run.repo}` : ''}: ${runnerDeadlineLine(run)}`);
  for (const proposal of summary.submitInvariantProposals) io.say(submitInvariantLine(proposal));
  for (const need of summary.needs.filter(need => need.kind === 'agent-approved')) io.say(`${need.text}; ${need.what}`);
  if (!summary.relay.linked && !originRepository(ctx.info.root, { optional: true })) {
    io.say('optional: add a GitHub origin and run pullboard relay on to link this board');
  }
  if (Object.keys(ctx.config.products).length) {
    const all = await withBoardRead(ctx, (board) => store.listItems(board, { all: true }));
    productSummaries(ctx.config, loadSpec(ctx.info.root, ctx.config), all).forEach((product) => io.say(productLine(product)));
  }
  return 0;
}
