/** Compose the real native board for in-process CLI tests [C7]. */
import { fileURLToPath } from 'node:url';
import {
  main as cliMain,
  nativeBoardOpeners,
} from '../../index.js';
import { nativeBoardPorts } from '../../../lib/index.js';
import { HOOK_WORKER } from '../../index.js';
import * as nativeBoard from '../../../lib/src/logic/native.js';
import { launchRelaySender } from '../../index.js';
import {
  flushOutbox,
  queueMove,
  outboxHasPendingCreatedItem,
  outboxFields,
  ACKNOWLEDGED_OPERATIONS,
  outboxQueueable,
} from '../../../../packages/outbox/index.js';
const checkpointWorker = fileURLToPath(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from '../../../../packages/outbox/index.js';
import { replay as replayConflictRecord } from '../../../../packages/outbox/index.js';
import {
  remoteBoardMissing,
  uncertainUploadFailure,
  decideUncertainBaseline,
} from '../../../../packages/outbox/index.js';
import {
  checkpointInBackground,
  scheduleCheckpoint,
  requestCheckpointCheck,
} from '../../../../packages/outbox/index.js';
import { checkpointPublisher } from '../../../../packages/outbox/index.js';
import { relayOrdering } from '../../../../packages/outbox/index.js';

/** Run the production CLI with the same explicit native capability as its process entry. */
export function main(argv, streams) {
  return cliMain(argv, { ...streams, nativeBoardPorts: streams?.nativeBoardPorts ?? nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker: HOOK_WORKER, submitHandoffWorker: fileURLToPath(new URL('../../src/io/submit/handoff/worker.js', import.meta.url)), launchRelaySender, loadNativeBoard: streams?.loadNativeBoard ?? (() => Promise.resolve(nativeBoard)) });
}

/** The board and outbox ports the production process entry composes, as a relay setup flow receives them in its output object [C7]. */
export function nativeRelayPorts() {
  return nativeBoardOpeners({ nativeBoard, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
}
