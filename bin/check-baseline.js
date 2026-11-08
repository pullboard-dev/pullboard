#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/** Private detached baseline worker; no command or caller-supplied result comes from its arguments [V2,H16]. */
const emitWarning = process.emitWarning;
/** Hide only Node's experimental SQLite notice, as the main CLI does. */
process.emitWarning = (warning, ...rest) => {
  if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
};
const [root, rawId, request] = process.argv.slice(2);
if (root && /^[1-9]\d*$/.test(rawId ?? '') && /^[a-f0-9-]{36}$/.test(request ?? '')) {
  const { openBoard, nativeBoardPorts } = await import('../apps/lib/index.js');
  const { withOutboxGuard } = await import('../packages/outbox/index.js');
  const { replay: replayConflictRecord } = await import('../packages/outbox/index.js');
  const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import('../packages/outbox/index.js');
  const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import('../packages/outbox/index.js');
  const { checkpointPublisher } = await import('../packages/outbox/index.js');
  const { relayOrdering } = await import('../packages/outbox/index.js');
  const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import('../packages/outbox/index.js');
  const checkpointWorker = fileURLToPath(new URL('../apps/lib/src/shell/relay-checkpoint-worker.js', import.meta.url));
  const { runCheckBaselineWorker } = await import('../packages/gate/index.js');
  // The baseline runs on a registered runner like any gate run, under the light gate-slot services [C7,#2520].
  const { gateSlotServices } = await import('./gate-slot-services.js');
  try { await runCheckBaselineWorker(root, Number(rawId), request, { openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, gateExecutionServices: gateSlotServices }); }
  catch { process.exitCode = 1; }
} else process.exitCode = 2;
