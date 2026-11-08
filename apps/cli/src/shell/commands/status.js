import { claimHealthProjection } from '../../../../../packages/health/index.js';
import { currentProofCounters } from '../../../../../packages/verify/index.js';
import { proofCounter } from '../../../../../packages/verify/index.js';
import { localDependencyIds } from '../../../../../packages/items/index.js';
import { dependencyLabel } from '../../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { allItemsNeedingRescope } from '../../../../../packages/store/index.js';
import { withLocalSeatPresence } from '../../../../../packages/store/index.js';
import { readCapacity } from '../../../../../packages/stats/index.js';
import { capacityLines } from '../../../../../packages/stats/index.js';
import { releaseBlockingItems } from '../../../../../packages/health/index.js';
import { staleStateSnapshot } from '../../../../../packages/health/index.js';
import { staleStateLine } from '../../../../../packages/store/index.js';
import { lineSettings } from '../../../../../packages/state/index.js';
import { routingCapacity } from '../../../../../src/routing-capacity.js';
import { foreignBlockers } from '../../../../../packages/items/index.js';
import { readReceivedBoardState } from '../../../../../packages/store/index.js';
import { existsSync } from 'node:fs';
import { relayMachineDirectory } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { handoffWorkerAlive } from '../handoff-worker-alive.js';
import { stalledGates } from '../../../../../packages/jobs/index.js';
import { withBoardRead } from '../cli-board-read.js';
import { fallbackReclaim } from '../fallback-reclaim.js';
import { diskLines } from '../disk-use.js';
import { diskUse } from '../disk-use.js';
import { refusingBadPolicy } from '../disk-use.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { join } from 'node:path';
/** The pullboard status command, in its own module so an item adding another command never edits these lines. */
import { landWhy } from '../../../../../packages/landing/src/core/land-why.js';
import { landingLine } from '../../../../../packages/landing/src/core/land-why.js';
import * as store from '../../../../../packages/store/index.js';
import { personNeedsSummary } from '../../../../view/index.js';
import { identifyCaller } from '../cli-read-context.js';
import { relayStateExists } from '../../../../../packages/store/index.js';
import { unlinkedRelayStatus } from '../../../../../packages/link/index.js';
import { ruleProofCounts } from '../../../../../packages/verify/index.js';
import { memoryHeldRuns } from '../../../../../packages/store/index.js';
import { readRunnerUtilization } from '../../../../../packages/runners/index.js';
import { handoffCapLine } from '../../../../../packages/resources/index.js';
import { longestRecentHolds } from '../../../../../src/board-hold-log.js';
import { runnerDeadlineLine } from '../../../../../packages/resources/index.js';
import { runnerDeadlineRuns } from '../../../../../packages/runners/index.js';
import { reviewQueueLine } from '../../../../../packages/verify/index.js';
import {
  productLine,
  productSummaries,
} from '../../../../../packages/spec/index.js';
import { originRepository } from '../../../../../packages/seats/index.js';
import {
  loadSpec,
} from '../../../../../packages/spec/index.js';
import {
  signingLine,
} from '../../../../../packages/person/index.js';
import {
  submitInvariantLine,
  submitInvariantProposals,
} from '../../../../../packages/items/index.js';
import {
  context,
  span,
} from '../cli-read-context.js';

/** Bind authenticated foreign state to the status reader's existing read-only board. */
function statusForeignBlockers(board, item) {
  return foreignBlockers(board, item, { readReceivedBoardState });
}

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/** Run `pullboard status` and return its exit code. */
export async function run(io, { values }) {
  const ctx = context(io);
  const hasRelayState = relayStateExists(ctx.info.commonDir);
  if (hasRelayState) await io.prepareProcessPorts?.();
  const relay = hasRelayState ? (({ relayLinked, relayStatus }) => ({ relayLinked, relayStatus }))(await import('../../../../../packages/link/index.js')) : null;
  const environment = hasRelayState && process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? (({ environmentAgent }) => ({ environmentAgent }))(await import('../../../../../packages/link/index.js')) : null;
  // One fallback reclaim pass before answering: a gate job stalled by a dead dispatcher moves one step (DJ15).
  const reclaim = await fallbackReclaim(ctx, 'status');
  let landing = null;
  const summary = await withBoardRead(ctx, async (board, readers) => {
    const me = identifyCaller(ctx, board, { environmentAgent: environment?.environmentAgent ?? (() => null),
      relayLinked: relay?.relayLinked ?? (() => false) }, readers);
    const mine = store.itemsInStatus(board, 'claimed', me.id);
    const agents = store.listAgents(board);
    const presenceCounts = { live: 0, idle: 0, gone: 0 };
    for (const seat of agents) presenceCounts[seat.presence] += 1;
    const blockers = releaseBlockingItems(board);
    const observedStaleState = staleStateSnapshot(board, ctx.config, { now: ctx.clock.now(), seats: agents, blocker: item => blockers.has(item.item_id) ? true : null });
    const staleState = { ...observedStaleState,
      holds: observedStaleState.holds.filter(entry => entry.pastHalf),
      claims: observedStaleState.claims.filter(entry => entry.pastHalf),
      reviews: observedStaleState.reviews.filter(entry => entry.pastHalf),
      // Claims not building, from real work signals only (#1225): stalled after 20 idle minutes, or waiting on an unlanded item.
      claimHealth: observedStaleState.claims.filter(entry => entry.health && entry.health !== 'building')
        .map(({ id, actor, health, idleMs, waitingOn }) => ({ id, actor, health, idleMs, waitingOn })) };
    const needsRescope = allItemsNeedingRescope(board);
    const approvalState = personNeedsSummary(ctx.info.root, { board, config: ctx.config, agents, doctrine: ctx.doctrine });
    const person = board.db.prepare("SELECT 1 FROM event WHERE event_kind='person_signing' LIMIT 1").get()
      ? { signed: (await import('../../../../../packages/person/index.js')).personSigning(board).signed } : { signed: false };
    landing = landWhy(board, ctx.clock.now());
    return { stalledGates: stalledGates(board.db, { workerAlive: view => { const job = view.item == null ? null : submitHandoff(board, view.item); return job?.id === view.id && handoffWorkerAlive(board, job); } }), needsRescope, me, mine, claimHealth: Object.fromEntries(claimHealthProjection(observedStaleState)), person, agents, presenceCounts, capacity: routingCapacity(board, agents, statusForeignBlockers, { ...readers, localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence, lineSettings }), capacityForecast: readCapacity(board, undefined, { currentProofCounters, proofCounter }), staleState, ruleCounts: ruleProofCounts(ctx.info.root, board, approvalState.spec), needs: approvalState.needs, specApprovalBaseline: approvalState.specApprovalBaseline, specApprovalEvidenceErrors: approvalState.specApprovalEvidenceErrors, stats: store.stats(board), reviewQueue: { ...store.reviewQueue(board), ...store.reviewQueueBreakdown(board) }, unread: store.unreadCount(board, me.id), relay: relay ? relay.relayStatus(ctx.info.root, io) : unlinkedRelayStatus(),
      submitInvariantProposals: submitInvariantProposals(store.submitInvariantEvents(board, ctx.config), ctx.config) };
  });
  if (!summary.relay.linked && existsSync(relayMachineDirectory())) {
    const exclusion = (await import('../../../../../packages/link/index.js')).relayExclusion(ctx.info.root);
    if (exclusion) Object.assign(summary.relay, { excluded: true, exclusion });
  }
  summary.reclaim = reclaim;
  summary.memoryHeld = memoryHeldRuns();
  summary.runnerDeadlines = runnerDeadlineRuns();
  summary.runnerUtilization = readRunnerUtilization(ctx.info.root);
  summary.longestHolds = longestRecentHolds();
  summary.disk = refusingBadPolicy(() => diskUse(join(ctx.info.commonDir, 'pullboard'), { now: ctx.clock.now().getTime(), maxAgeMs: 10 * 60_000 }), Refused);
  if (values.json) {
    io.result(summary);
    return 0;
  }
  if (hasRelayState || summary.relay.excluded) for (const line of (await import('../../../../../packages/link/index.js')).briefLines(summary.relay, (({ describeMove, refusalLine }) => ({ describeMove, refusalLine }))(await import('../../../../../packages/outbox/index.js')))) io.say(line);
  const { stages, accepted, rejected } = summary.stats;
  io.say(`${summary.me.displayName}: ${summary.unread} unread shouts; holding ${summary.mine.map((item) => `#${item.item_id}`).join(', ') || 'nothing'}`);
  io.say(`board: ${Object.entries(stages).map(([stage, total]) => `${total} ${stage}`).join(', ')}`);
  io.say(`verdicts: ${accepted} accepted, ${rejected} rejected`);
  if (summary.specApprovalBaseline?.pending) io.say('approval baseline pending: the next coordinator or person command in the main checkout records the existing approved rows; lane work may continue and none are flagged until then');
  if (summary.specApprovalBaseline?.invalid) io.say('approval baseline unreadable: existing rows need approval evidence; restore a known-good board export to recover the original baseline');
  io.say(reviewQueueLine(ctx, summary.reviewQueue, span));
  io.say(landingLine(landing));
  for (const line of capacityLines(summary.capacityForecast)) io.say(line);
  io.say(signingLine(summary.person));
  for (const entry of [...summary.staleState.holds, ...summary.staleState.claims, ...summary.staleState.reviews]) {
    const incomplete = entry.evidence?.complete !== true;
    const classification = entry.classificationUnknown ? '; blocker classification unknown; shown at shortest possible half-limit' : '';
    io.say(`past half limit: ${staleStateLine(incomplete ? { ...entry, expired: false } : entry)}${incomplete ? '; inactivity unproven (evidence unknown)' : ''}${classification}`);
  }
  for (const entry of summary.needsRescope ?? []) io.say(`needs re-scope: #${entry.id} is not offered to ${entry.lane} at the ${entry.route} route; ${entry.reasons.join('; ')}; edit, refreeze or re-route it`);
  for (const entry of summary.staleState.claimHealth ?? []) {
    io.say(entry.health === 'waiting' ? `waiting: #${entry.id} (${entry.actor}) waits on ${entry.waitingOn.map(id => `#${id}`).join(', ')} to land; the claim is released and the item returns when it lands`
      : `stalled: #${entry.id} (${entry.actor}) idle ${Math.floor(entry.idleMs / 60_000)}m with no commit, file change, running check or item move; released automatically at 40m`);
  }
  for (const gate of summary.stalledGates) io.say(`gate job ${gate.id}${gate.item ? ` (#${gate.item})` : ''}: ${gate.text}`);
  for (const warning of summary.runnerUtilization.warnings) io.say(warning);
  io.say(`seats: ${summary.presenceCounts.live} live, ${summary.presenceCounts.idle} idle, ${summary.presenceCounts.gone} gone`);
  io.say(`capacity: ${summary.capacity.liveAgents} live, ${summary.capacity.idleAgents} idle, ${summary.capacity.readyItems} ready item${summary.capacity.readyItems === 1 ? '' : 's'}`);
  for (const seat of summary.agents.filter(seat => values.all || seat.presence !== 'gone')) io.say(`${seat.agent_id}: ${seat.presence}${seat.heartbeatAt ? ` (heartbeat ${seat.heartbeatAt})` : ' (no local heartbeat)'}`);
  if (summary.memoryHeld === null) io.say('local memory hold status unavailable; pullboard resources shows the queue');
  else for (const run of summary.memoryHeld) io.say(`local memory holds ${run.agent}${run.item ? ` #${run.item}` : ''}${run.kind ? ` (${run.kind})` : ''}${run.repo ? ` in ${run.repo}` : ''}`);
  if (summary.runnerDeadlines === null) io.say('runner wait deadline status unavailable; pullboard resources shows the queue');
  else for (const run of summary.runnerDeadlines) io.say(`${run.agent}${run.item ? ` #${run.item}` : ''}${run.repo ? ` in ${run.repo}` : ''}: ${runnerDeadlineLine(run)}`);
  for (const hold of summary.longestHolds ?? []) io.say(`board hold ${hold.at}: ${hold.heldMs} ms in ${hold.move ?? 'unknown move'}${hold.step ? `, slowest step ${hold.step} ${hold.stepMs ?? '?'} ms` : ''}`);
  for (const line of diskLines(summary.disk)) io.say(line);
  const handoffCap = handoffCapLine();
  if (handoffCap) io.say(handoffCap);
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
