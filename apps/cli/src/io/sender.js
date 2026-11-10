/** @pullboard-module-loads apps/cli/src/io/submit/handoff/worker.js */
/** CLI-owned composition and process launch for the machine relay sender [H21,H16,C7]. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRelaySender } from '../../../../packages/outbox/index.js';
import { outboxWaiting } from '../../../../packages/outbox/index.js';
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

/** The actual CLI composition entry executed by background sender processes. */
export const SENDER_WORKER = fileURLToPath(import.meta.url);

/** Launch one detached native sender using the already-filtered caller environment. */
export function launchRelaySender(root, env) {
  const child = spawn(process.execPath, [SENDER_WORKER], { cwd: root, detached: true, stdio: 'ignore', env });
  child.unref();
}

/**
 * The io the machine sender gives a relay sync: the caller's streams plus every native service the sync reads.
 * Why: one composition serves the sender and the tests that drive a sync, so neither drifts when a service is added [H21,H16,C7].
 *
 * @param {string} root - The board's repository root.
 * @param {object} [io] - The caller's streams and settings, kept as given.
 * @returns {Promise<object>}
 */
export async function relaySenderIo(root, io = {}) {
  const { relayOutboxSetting } = await import('./entry.js');
  const loadNativeBoard = () => import('../../../lib/index.js');
  const hookWorker = fileURLToPath(new URL('./hook/work.js', import.meta.url));
  const submitHandoffWorker = fileURLToPath(new URL('./submit/handoff/worker.js', import.meta.url));
  const nativeBoard = await loadNativeBoard();
  return { ...io, openBoard: nativeBoard.openBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, hookWorker, submitHandoffWorker, nativeBoard, loadNativeBoard, launchRelaySender, relayOutbox: () => relayOutboxSetting(root) };;
}

/** Send and pull one board under its relay lock, then run the person's waiting requests. True when nothing waits. */
async function serve(root, file, io) {
  const { syncRelay } = await import('../../../../packages/link/index.js');
  const loadNativeBoard = () => import('../../../lib/index.js');
  const hookWorker = fileURLToPath(new URL('./hook/work.js', import.meta.url));
  const submitHandoffWorker = fileURLToPath(new URL('./submit/handoff/worker.js', import.meta.url));
  const boardIo = await relaySenderIo(root, io);
  await syncRelay(root, boardIo);
  try {
    const { executePersonRequests } = await import('../../../../packages/link/index.js');
    const { main } = await import('./main.js');
    /** Retain the sender process's explicit native capabilities in person commands. */
    const runCommand = (args, streams) => main(args, { ...streams, loadNativeBoard, hookWorker, submitHandoffWorker, launchRelaySender, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, checkpointWorker, outboxPolicy, outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem });
    const { nativePersonRequestPorts } = await import('./context.js');
    await executePersonRequests(root, boardIo, runCommand, nativePersonRequestPorts(boardIo));
  } catch (error) { io.err(`person requests not run: ${error.message}`); }
  return !outboxWaiting(file);
}

/**
 * Start the sender loop without a top-level await. Why: serve() imports the cli door, whose graph reaches
 * apps/lib/index.js and so this module; while this module's evaluation awaited the loop, that import waited on it
 * forever and the sender hung after "serving" (#3204).
 */
function startSender() {
  runRelaySender({ serve }).catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`relay sender stopped: ${error.message}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SENDER_WORKER) startSender();
