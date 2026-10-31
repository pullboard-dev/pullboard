/** Compose the real native board for in-process CLI tests [C7]. */
import { fileURLToPath } from 'node:url';
import { main as cliMain } from '../src/cli-main.js';
import { HOOK_WORKER } from '../src/cli-hook-work.js';
import { launchRelaySender } from '../src/relay-sender-main.js';
import { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } from '../src/relay-outbox.js';
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../src/relay-outbox-guard.js';
import { replay as replayConflictRecord } from '../src/relay-conflict-record.js';
import { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } from '../src/relay-baseline-settle.js';
import { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } from '../src/relay-checkpoint.js';
import { checkpointPublisher } from '../src/relay-checkpoint-publish.js';
import { relayOrdering } from '../src/relay-ordering.js';

/** Run the production CLI with the same explicit native capability as its process entry. */
export function main(argv, streams) {
  return cliMain(argv, { ...streams, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker: HOOK_WORKER, submitHandoffWorker: fileURLToPath(new URL('../src/submit-handoff-worker.js', import.meta.url)), launchRelaySender, loadNativeBoard: () => import('../src/native-board.js') });
}
