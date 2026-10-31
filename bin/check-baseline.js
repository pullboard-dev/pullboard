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
  const { openBoard, nativeBoardPorts } = await import('../src/native-board.js');
  const { withOutboxGuard } = await import('../src/relay-outbox-guard.js');
  const { replay: replayConflictRecord } = await import('../src/relay-conflict-record.js');
  const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import('../src/relay-baseline-settle.js');
  const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import('../src/relay-checkpoint.js');
  const { checkpointPublisher } = await import('../src/relay-checkpoint-publish.js');
  const { relayOrdering } = await import('../src/relay-ordering.js');
  const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import('../src/relay-outbox.js');
  const checkpointWorker = fileURLToPath(new URL('../src/relay-checkpoint-worker.js', import.meta.url));
  const { runCheckBaselineWorker } = await import('../src/check-baseline-worker.js');
  try { await runCheckBaselineWorker(root, Number(rawId), request, { openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem }); }
  catch { process.exitCode = 1; }
} else process.exitCode = 2;
