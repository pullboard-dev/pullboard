/** Compose the real native board for in-process CLI tests [C7]. */
import { fileURLToPath } from 'node:url';
import { main as cliMain } from '../src/cli-main.js';
import { HOOK_WORKER } from '../src/cli-hook-work.js';
import { launchRelaySender } from '../src/relay-sender-main.js';
import { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } from '../packages/outbox/index.js';
const checkpointWorker = fileURLToPath(new URL('../apps/lib/src/shell/relay-checkpoint-worker.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../packages/outbox/index.js';
import { replay as replayConflictRecord } from '../packages/outbox/index.js';
import { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } from '../packages/outbox/index.js';
import { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } from '../packages/outbox/index.js';
import { checkpointPublisher } from '../packages/outbox/index.js';
import { relayOrdering } from '../packages/outbox/index.js';

/** Run the production CLI with the same explicit native capability as its process entry. */
export function main(argv, streams) {
  return cliMain(argv, { ...streams, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker: HOOK_WORKER, submitHandoffWorker: fileURLToPath(new URL('../apps/lib/src/shell/submit-handoff-worker.js', import.meta.url)), launchRelaySender, loadNativeBoard: () => import('../src/native-board.js') });
}
