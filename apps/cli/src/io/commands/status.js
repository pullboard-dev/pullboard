import { localDependencyIds } from '../../../../../packages/items/light.js';
import { dependencyLabel } from '../../../../../packages/items/light.js';
import { itemFileCollisions } from '../../../../../packages/items/light.js';
import { allItemsNeedingRescope } from '../../../../../packages/store/index.js';
import { withLocalSeatPresence } from '../../../../../packages/store/index.js';
import { readCapacity } from '../../../../../packages/stats/light.js';
import { capacityLines } from '../../../../../packages/stats/light.js';
import { statusShowUsefulBuilders } from '../../../../../packages/config/index.js';
import { readMaxUsefulBuilders } from '../../../../../packages/stats/light.js';
import { usefulBuilderLines } from '../../../../../packages/stats/light.js';
import { staleStateLine } from '../../../../../packages/store/index.js';
import { lineSettings } from '../../../../../packages/state/light.js';
import { routingCapacity } from '../../../../../packages/queue/light.js';
import { foreignBlockers } from '../../../../../packages/items/light.js';
import { readReceivedBoardState } from '../../../../../packages/store/index.js';
import { existsSync } from 'node:fs';
import { relayMachineDirectory } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { handoffWorkerAlive } from '../alive.js';
import { withBoardRead } from '../board/read.js';
import { fallbackReclaim } from '../reclaim.js';
import { diskLines } from '../disk/use.js';
import { cachedDiskUse } from '../disk/use.js';
import { refusingBadPolicy } from '../disk/use.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { join } from 'node:path';
/** The pullboard status command, in its own module so an item adding another command never edits these lines. */
import { statusLines } from '../../logic/status/render.js';
import { landWhy } from '../../../../../packages/landing/light.js';
import { landingLine } from '../../../../../packages/landing/light.js';
import * as store from '../../../../../packages/store/index.js';
import { identifyCaller } from '../read.js';
import { relayStateExists } from '../../../../../packages/store/index.js';
import { fileURLToPath } from 'node:url';
import { memoryHeldRuns } from '../../../../../packages/store/index.js';
import { longestRecentHolds } from '../../../../../packages/store/index.js';
import {
  productLine,
  productSummaries,
} from '../../../../../packages/spec/index.js';
import { originRepository } from '../../../../../packages/seats/light.js';
import {
  loadSpec,
} from '../../../../../packages/spec/index.js';
import {
  signingLine,
} from '../../../../../packages/person/light.js';
import {
  context,
  span,
} from '../read.js';

/** Bind authenticated foreign state to the status reader's existing read-only board. */
function statusForeignBlockers(board, item) {
  return foreignBlockers(board, item, { readReceivedBoardState });
}

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/** Run `pullboard status` and return its exit code. */
export async function run(io, { values }) {
  const ctx = context(io);
  const { submitInvariantLine, submitInvariantProposals } = await import('../../../../../packages/items/index.js');
  const { bindProofRunner, currentProofCounters, proofCounter, ruleProofCounts, reviewQueueLine } = await import('../../../../../packages/verify/index.js');
  const { claimHealthProjection, releaseBlockingItems, staleStateSnapshot } = await import('../../../../../packages/health/index.js');
  const { stalledGates } = await import('../../../../../packages/jobs/index.js');
  const { runnerDeadlineLine } = await import('../../../../../packages/resources/index.js');
  // Status does not load the library root that binds the runner; unbound, its coverage fingerprint never matches the writer's.
  bindProofRunner(fileURLToPath(new URL('../run/tests.js', import.meta.url)));
  const hasRelayState = relayStateExists(ctx.info.commonDir);
  if (hasRelayState) await io.prepareProcessPorts?.();
  const relay = hasRelayState ? (({ relayLinked, relayStatus }) => ({ relayLinked, relayStatus }))(await import('../../../../../packages/link/index.js')) : null;
  const unlinkedRelayStatus = hasRelayState ? null : (await import('../../../../../packages/link/index.js')).unlinkedRelayStatus;
  const environment = hasRelayState && process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? (({ environmentAgent }) => ({ environmentAgent }))(await import('../../../../../packages/link/index.js')) : null;
  // One fallback reclaim pass before answering: a gate job stalled by a dead dispatcher moves one step (DJ15).
  const reclaim = await fallbackReclaim(ctx, 'status');
  let landing = null;
  let batchLine = null;
  // Loaded only when landing.adaptiveBatch is on: off, the landing batch module stays out of status, which pays for render.js [C7].
  const { adaptiveBatchEnabled } = await import('../../../../../packages/config/index.js');
  const adaptiveBatch = adaptiveBatchEnabled();
  const adaptiveBatchLine = adaptiveBatch ? (await import('../landing/adaptive.js')).adaptiveBatchLine : null;
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
    const { personNeedsSummary } = await import('../../../../view/needs.js');
    const approvalState = personNeedsSummary(ctx.info.root, { board, config: ctx.config, agents, doctrine: ctx.doctrine });
    const person = board.db.prepare("SELECT 1 FROM event WHERE event_kind='person_signing' LIMIT 1").get()
      ? { signed: (await import('../../../../../packages/person/index.js')).personSigning(board).signed } : { signed: false };
    landing = landWhy(board, ctx.clock.now());
    batchLine = adaptiveBatchLine?.(board, adaptiveBatch) ?? null;
    return { noRunnerGates: store.listItems(board).filter(item => item.item_gate_runner === 'none').map(item => item.item_id), stalledGates: stalledGates(board.db, { workerAlive: view => { const job = view.item == null ? null : submitHandoff(board, view.item); return job?.id === view.id && handoffWorkerAlive(board, job); } }), needsRescope, me, mine, claimHealth: Object.fromEntries(claimHealthProjection(observedStaleState)), person, agents, presenceCounts, capacity: routingCapacity(board, agents, statusForeignBlockers, { ...store, localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence, lineSettings }), capacityForecast: readCapacity(board, undefined, { currentProofCounters, proofCounter }), usefulBuilders: statusShowUsefulBuilders() ? readMaxUsefulBuilders(board.db, ctx.clock.now()) : null, staleState, ruleCounts: ruleProofCounts(ctx.info.root, board, approvalState.spec), needs: approvalState.needs, specApprovalBaseline: approvalState.specApprovalBaseline, specApprovalEvidenceErrors: approvalState.specApprovalEvidenceErrors, stats: store.stats(board), reviewQueue: { ...store.reviewQueue(board), ...store.reviewQueueBreakdown(board) }, unread: store.unreadCount(board, me.id), relay: relay ? relay.relayStatus(ctx.info.root, io) : unlinkedRelayStatus(),
      submitInvariantProposals: submitInvariantProposals(store.submitInvariantEvents(board, ctx.config), ctx.config) };
  });
  if (!summary.relay.linked && existsSync(relayMachineDirectory())) {
    const exclusion = (await import('../../../../../packages/link/index.js')).relayExclusion(ctx.info.root);
    if (exclusion) Object.assign(summary.relay, { excluded: true, exclusion });
  }
  summary.reclaim = reclaim;
  summary.landingBatch = batchLine;
  summary.memoryHeld = memoryHeldRuns();
  // These status readers load here, not through the packages' light doors: those doors are the runner worker's, and a status reader in them widens the worker bundle [C7].
  const { retainedReceipts } = await import('../../../../../packages/gate/index.js');
  const { readRunnerUtilization, runnerDeadlineRuns } = await import('../../../../../packages/runners/index.js');
  summary.runnerDeadlines = runnerDeadlineRuns();
  summary.runnerUtilization = readRunnerUtilization(ctx.info.root, retainedReceipts);
  summary.longestHolds = longestRecentHolds();
  summary.disk = refusingBadPolicy(() => cachedDiskUse(join(ctx.info.commonDir, 'pullboard'), { now: ctx.clock.now().getTime(), maxAgeMs: 10 * 60_000 }), Refused);
  if (values.json) {
    io.result(summary);
    return 0;
  }
  if (hasRelayState || summary.relay.excluded) for (const line of (await import('../../../../../packages/link/index.js')).briefLines(summary.relay, (({ describeMove, refusalLine }) => ({ describeMove, refusalLine }))(await import('../../../../../packages/outbox/index.js')))) io.say(line);
  const originHint = !summary.relay.linked && !originRepository(ctx.info.root, { optional: true });
  const format = { capacityLines, usefulBuilderLines, signingLine, staleStateLine, runnerDeadlineLine, submitInvariantLine, diskLines };
  for (const line of statusLines(summary, { all: values.all, reviewQueue: reviewQueueLine(ctx, summary.reviewQueue, span), landing: landingLine(landing), originHint, format })) io.say(line);
  if (Object.keys(ctx.config.products).length) {
    const all = await withBoardRead(ctx, (board) => store.listItems(board, { all: true }));
    productSummaries(ctx.config, loadSpec(ctx.info.root, ctx.config), all).forEach((product) => io.say(productLine(product)));
  }
  return 0;
}
