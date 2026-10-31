/** @pullboard-module-loads src/submit-handoff-worker.js */
/** CLI-owned composition and process launch for the machine relay sender [H21,H16,C7]. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRelaySender } from './relay-sender-worker.js';
import { outboxWaiting } from './relay-outbox.js';
import {
  flushOutbox,
  queueMove,
  outboxHasPendingCreatedItem,
  outboxFields,
  ACKNOWLEDGED_OPERATIONS,
  outboxQueueable,
} from './relay-outbox.js';
const checkpointWorker = fileURLToPath(new URL('./relay-checkpoint-worker.js', import.meta.url));
const outboxPolicy = () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable });
import { withOutboxGuard } from './relay-outbox-guard.js';
import { replay as replayConflictRecord } from './relay-conflict-record.js';
import {
  remoteBoardMissing,
  uncertainUploadFailure,
  decideUncertainBaseline,
} from './relay-baseline-settle.js';
import {
  checkpointInBackground,
  scheduleCheckpoint,
  requestCheckpointCheck,
} from './relay-checkpoint.js';
import { checkpointPublisher } from './relay-checkpoint-publish.js';
import { relayOrdering } from './relay-ordering.js';

/** The actual CLI composition entry executed by background sender processes. */
export const SENDER_WORKER = fileURLToPath(import.meta.url);

/** Launch one detached native sender using the already-filtered caller environment. */
export function launchRelaySender(root, env) {
  const child = spawn(process.execPath, [SENDER_WORKER], { cwd: root, detached: true, stdio: 'ignore', env });
  child.unref();
}

/** Send and pull one board under its relay lock, then run the person's waiting requests. True when nothing waits. */
async function serve(root, file, io) {
  const { syncRelay } = await import('./relay.js');
  const { relayOutboxSetting } = await import('./cli.js');
  const loadNativeBoard = () => import('./native-board.js');
  const hookWorker = fileURLToPath(new URL('./cli-hook-work.js', import.meta.url));
  const submitHandoffWorker = fileURLToPath(new URL('./submit-handoff-worker.js', import.meta.url));
  const nativeBoard = await loadNativeBoard();
  const boardIo = { ...io, openBoard: nativeBoard.openBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker, submitHandoffWorker, nativeBoard, loadNativeBoard, launchRelaySender, relayOutbox: () => relayOutboxSetting(root) };
  await syncRelay(root, boardIo);
  try {
    const { executePersonRequests } = await import('./relay-request-execution.js');
    const { main } = await import('./cli-main.js');
    /** Retain the sender process's explicit native capabilities in person commands. */
    const runCommand = (args, streams) => main(args, { ...streams, loadNativeBoard, hookWorker, submitHandoffWorker, launchRelaySender, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
    const { nativePersonRequestPorts } = await import('./cli-context.js');
    await executePersonRequests(root, boardIo, runCommand, nativePersonRequestPorts(boardIo));
  } catch (error) { io.err(`person requests not run: ${error.message}`); }
  return !outboxWaiting(file);
}

if (process.argv[1] && resolve(process.argv[1]) === SENDER_WORKER) await runRelaySender({ serve });
