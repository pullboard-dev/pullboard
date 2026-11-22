/** @pullboard-module-loads apps/cli/index.js apps/lib/index.js packages/outbox/index.js apps/lib/src/io/worker/checkpoint/relay.js */
/** Compose the real native board for in-process CLI tests [C7]. */
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
  return cliMain(argv, { ...streams, nativeBoardPorts: streams?.nativeBoardPorts ?? nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker: HOOK_WORKER, launchRelaySender, loadNativeBoard: streams?.loadNativeBoard ?? (() => Promise.resolve(nativeBoard)) });
}

/** The board and outbox ports the production process entry composes, as a relay setup flow receives them in its output object [C7]. */
export function nativeRelayPorts() {
  return nativeBoardOpeners({ nativeBoard, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
}

/**
 * Compose the installed public CLI with the same installed board, outbox and worker capabilities.
 * The fixed paths below are copies of the declared source doors, not arbitrary entry overrides; loading occurs
 * inside captureCommandInProcess so initialization and dispatch both see the isolated fixture environment.
 */
export async function installedMain(installedRoot, argv, streams) {
  const root = pathToFileURL(`${resolve(installedRoot)}/`);
  const [cli, nativeBoard, outbox] = await Promise.all([
    import(new URL('apps/cli/index.js', root)),
    import(new URL('apps/lib/index.js', root)),
    import(new URL('packages/outbox/index.js', root)),
  ]);
  return cli.main(argv, { ...streams,
    nativeBoardPorts: nativeBoard.nativeBoardPorts,
    loadNativeBoard: () => Promise.resolve(nativeBoard),
    hookWorker: cli.HOOK_WORKER,
    launchRelaySender: cli.launchRelaySender,
    checkpointWorker: fileURLToPath(new URL('apps/lib/src/io/worker/checkpoint/relay.js', root)),
    ...outbox,
    replayConflictRecord: outbox.replay,
    outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
  });
}
