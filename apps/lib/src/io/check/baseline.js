#!/usr/bin/env node
/**
 * An item's check baseline: where it runs, and the private detached worker that measures it [V2,H16,C7,#10787].
 * No command or caller-supplied result comes from the worker's arguments.
 *
 * Why the launcher lives here: every add and edit started one detached worker, and each worker started a
 * committed-runner controller (--finish --serve-need) on the board machine, whatever gate.runnersOnly said. On 17 Nov a
 * re-bar wave of ~200 adds and edits put ~30 of them on the board Mac at load 90+, and the board API answered 503 to the
 * real runners (#10787). Now a board with runners queues the baseline as a runner job and starts no local process, and
 * with runners off the job waits on the board queue for this machine's one local runner.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** This file: the executable the gate package spawns as the detached worker. */
export const BASELINE_WORKER = fileURLToPath(import.meta.url);

/**
 * Start an item's recorded check baseline where it belongs [C7,#10787]:
 * - gate.runnersOnly on, or any registered runner: a runner job on the board's queue, and no process on this machine.
 *   Only a board this machine does not hold (a relay link) cannot queue here, so it keeps the detached worker, which
 *   hands the check to a runner;
 * - runners off: a job on the same queue for this machine's one local runner, which takes queued jobs in turn [P7].
 *   No detached worker starts: with no registered runner it has nowhere to measure (measureBaseline returns null), so
 *   it only cost a process per add. When the local runner cannot take it, the baseline stays pending, as before.
 *
 * @param {{ id: number, baseline: { result: string, request: string } }} request
 * @param {{ settings: { gate?: { runnersOnly?: boolean }, runners?: unknown[] },
 *   offer: () => boolean, local: () => Promise<boolean>, spawn: () => Promise<unknown> }} ports
 *   offer queues the runner job and says whether it could; local queues it for this machine's local runner and says
 *   whether that runner runs; spawn starts the detached worker.
 * @returns {Promise<{ route: 'none' | 'runner-job' | 'local-runner' | 'worker' | 'pending', exited?: unknown }>}
 */
export async function launchCheckBaseline({ baseline }, { settings, offer, local, spawn }) {
  if (baseline?.result !== 'pending') return { route: 'none' };
  if (settings?.gate?.runnersOnly === true || (settings?.runners ?? []).length) {
    return offer() ? { route: 'runner-job' } : { route: 'worker', exited: await spawn() };
  }
  return (await local()) ? { route: 'local-runner' } : { route: 'pending' };
}

/** Whether this module runs as the spawned worker rather than as an import. */
function spawnedAsWorker() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(BASELINE_WORKER); } catch { return false; }
}

/** The detached worker: measure its one request on a runner and record the result. */
async function work([root, rawId, request]) {
  if (!(root && /^[1-9]\d*$/u.test(rawId ?? '') && /^[a-f0-9-]{36}$/u.test(request ?? ''))) { process.exitCode = 2; return; }
  // Hide only Node's experimental SQLite notice, as the main CLI does.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
  };
  const { openBoard, nativeBoardPorts } = await import('../../../index.js');
  const { withOutboxGuard } = await import('../../../../../packages/outbox/index.js');
  const { replay: replayConflictRecord } = await import('../../../../../packages/outbox/index.js');
  const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import('../../../../../packages/outbox/index.js');
  const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import('../../../../../packages/outbox/index.js');
  const { checkpointPublisher } = await import('../../../../../packages/outbox/index.js');
  const { relayOrdering } = await import('../../../../../packages/outbox/index.js');
  const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import('../../../../../packages/outbox/index.js');
  const checkpointWorker = fileURLToPath(new URL('../worker/checkpoint/relay.js', import.meta.url));
  const { runCheckBaselineWorker } = await import('../../../../../packages/gate/heavy.js');
  // The baseline runs on a registered runner like any gate run, under the light gate-slot services [C7,#2520].
  const { gateSlotServices } = await import('../slot/services.js');
  const services = { openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, gateExecutionServices: gateSlotServices };
  try { await runCheckBaselineWorker(root, Number(rawId), request, services); }
  catch { process.exitCode = 1; }
}

if (spawnedAsWorker()) await work(process.argv.slice(2));
